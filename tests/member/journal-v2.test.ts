/**
 * The member journal, format 2 (#1561 PR 2): what it keeps through a crash, a full disk, a held record and a lock file
 * retired under a waiting writer.
 *
 * - G4a: a write cut off part-way (a killed hook, a full disk) loses at most its own line; the next append starts a
 *   fresh line, and the journal still deletes once delivered.
 * - G4f: a held event holds its own lane only. The session's transcript still ships, and only after the session's start.
 * - G4j: a turn-end mark is kept, in its own file, until it is consumed, and counts as satisfied once its transcript
 *   reached the mark's size or never will. A plugin-written transcript a pointer has not shipped is never aged out.
 * - D8: an older build that deletes a journal takes no mark with it.
 * - Retirement: a session's lock file outlives its journal, and goes only with its state, under the lock.
 *
 * G4i, the lock's identity check, is in `tests/utils/lock-file-identity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unboundedBudget } from '@myco/member/budget.js';
import { MEMBER_PROTOCOL } from '@myco/member/constants.js';
import { mintId, promptEvent, sessionStartEvent, type EnvelopeContext, type OutboundEvent } from '@myco/member/envelope.js';
import { bufferLockPath, readSessionState, retireSessionFiles, sessionStatePath, turnsFileOf, updateSessionState } from '@myco/member/session-state.js';
import { drainBacklog } from '@myco/member/backlog.js';
import { prunePluginTranscripts } from '@myco/member/retention.js';
import { isTurnEndMark, JOURNAL_VERSION, MemberSpool, turnEndSatisfied, type SpoolRecord, type TurnEndMark } from '@myco/member/spool.js';
import { listBufferSessionIds } from '@myco/capture/buffer.js';
import { shipSessionTranscripts, transcriptPointerFor } from '@myco/member/transcript.js';
import { ServerClient } from '@myco/member/transport.js';
import { isPrivateMode } from '@myco/member/store.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (() => true) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const SRC = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src');
const clientFor = (rig: MemberRig) => new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
const ctxFor = (spool: MemberSpool, sessionId: string): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });
const prompt = (ctx: EnvelopeContext, text = 'hello there') => promptEvent(ctx, { promptId: mintId(), text });
const journal = (spool: MemberSpool, sessionId: string) => path.join(spool.dir, `${sessionId}.jsonl`);

/** A transcript file of `n` lines, under a temp dir outside $TMPDIR's per-user tree. */
function transcriptFile(name: string, lines: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-journal-tx-'));
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, Array.from({ length: lines }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: `line ${i}` } })).join('\n') + '\n');
  return file;
}

describe('the journal, format 2', () => {
  it('stamps every line it writes with the journal format, and keeps turn-end marks out of the journal, in a file no build lists as one', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-stamp');
    spool.append('sess-stamp', prompt(ctx));
    spool.appendTurnEnd('sess-stamp', { slot: 'primary', transcriptId: 'tx_' + 'a'.repeat(32), atSize: 10 }, undefined, 1_234);
    const lines = spool.readRecords('sess-stamp');
    expect(lines).toHaveLength(1);
    expect(lines[0]!._journal).toBe(JOURNAL_VERSION);
    expect(lines[0]!._memberProtocol).toBe(MEMBER_PROTOCOL);
    const [pending] = spool.pendingTurnEnds('sess-stamp');
    expect(isTurnEndMark(pending.mark)).toBe(true);
    // Line 0 is the file's generation; the first mark is line 1.
    expect(pending).toMatchObject({ generation: expect.stringMatching(/^[0-9a-f]{16}$/), line: 1, mark: { t: 'te', _journal: JOURNAL_VERSION, slot: 'primary', atSize: 10, at: 1_234 } });
    // Owner-only where the mode means anything; Windows reports none (#1550).
    if (process.platform !== 'win32') expect(fs.statSync(turnsFileOf(spool.dir, 'sess-stamp')).mode & 0o777).toBe(0o600);
    // Every build finds journals by listing `*.jsonl`: the marks file is never taken for a session's journal.
    expect(listBufferSessionIds(spool.dir)).toEqual(['sess-stamp']);
    expect(spool.sessionIds()).toEqual(['sess-stamp']);
  });

  it('deletes a journal once its events are delivered, and keeps an unconsumed mark in its own file until it is consumed', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-mark');
    spool.append('sess-mark', prompt(ctx));
    spool.appendTurnEnd('sess-mark', { slot: 'primary', transcriptId: 'tx_' + 'b'.repeat(32), atSize: 5 });
    spool.append('sess-mark', prompt(ctx, 'and another'));

    const drained = await spool.drainSession('sess-mark', clientFor(rig), unboundedBudget());
    expect(drained).toMatchObject({ acked: 2, refused: 0, endedBy: 'drained' });
    expect(fs.existsSync(journal(spool, 'sess-mark'))).toBe(false);
    const pending = spool.pendingTurnEnds('sess-mark');
    expect(pending.map((p) => p.line)).toEqual([1]);

    // A mark appended after the consumer read is kept: the file goes only once every line in it is consumed.
    spool.appendTurnEnd('sess-mark', { slot: 'primary', transcriptId: 'tx_' + 'b'.repeat(32), atSize: 9 });
    spool.consumeTurnEnds('sess-mark', pending[0]);
    const later = spool.pendingTurnEnds('sess-mark');
    expect(later.map((p) => p.mark.atSize)).toEqual([9]);
    expect(readSessionState(spool.dir, 'sess-mark').markWater).toBe(2);
    spool.consumeTurnEnds('sess-mark', later[0]);
    expect(spool.pendingTurnEnds('sess-mark')).toEqual([]);
    expect(fs.existsSync(turnsFileOf(spool.dir, 'sess-mark'))).toBe(false);
    expect(readSessionState(spool.dir, 'sess-mark')).toMatchObject({ highWater: 0, markWater: 0 });
    expect(rig.rows('events')).toBe(2);
  });

  it('loses no mark to an older build that deletes the journal at its end (D8)', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-rollback');
    spool.append('sess-rollback', prompt(ctx));
    spool.appendTurnEnd('sess-rollback', { slot: 'primary', transcriptId: 'tx_' + 'c'.repeat(32), atSize: 7 });
    // This build's event lane delivers the journal and deletes it, as any build does at the journal's end.
    await spool.drainSession('sess-rollback', clientFor(rig), unboundedBudget());
    expect(fs.existsSync(journal(spool, 'sess-rollback'))).toBe(false);
    // An older build, rolled back to, lists journals by `*.jsonl` and drains, quarantines or deletes only those. It
    // sees one session's journal, written after the rollback, and deletes it at its end.
    spool.append('sess-rollback', prompt(ctx, 'after the rollback'));
    expect(listBufferSessionIds(spool.dir)).toEqual(['sess-rollback']);
    for (const id of listBufferSessionIds(spool.dir)) fs.unlinkSync(path.join(spool.dir, `${id}.jsonl`));
    // The mark is still there to be read once this build is back.
    expect(spool.pendingTurnEnds('sess-rollback').map((p) => p.mark)).toEqual([expect.objectContaining({ t: 'te', atSize: 7 })]);
  });

  it('never lets a consumer holding an older marks file\'s place consume a newer file\'s mark', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const mark = (atSize: number) => ({ slot: 'primary' as const, transcriptId: 'tx_' + 'e'.repeat(32), atSize });
    spool.appendTurnEnd('sess-stale', mark(1));
    // Two consumers read the same mark; the first consumes it, and the file goes.
    const [held] = spool.pendingTurnEnds('sess-stale');
    spool.consumeTurnEnds('sess-stale', spool.pendingTurnEnds('sess-stale')[0]);
    expect(fs.existsSync(turnsFileOf(spool.dir, 'sess-stale'))).toBe(false);
    // A new turn's mark lands in a new file, at the same line the old one stood at.
    spool.appendTurnEnd('sess-stale', mark(2));
    const [fresh] = spool.pendingTurnEnds('sess-stale');
    expect(fresh.line).toBe(held.line);
    expect(fresh.generation).not.toBe(held.generation);
    // The slow consumer acts on the old place: it consumes nothing of the new file.
    spool.consumeTurnEnds('sess-stale', held);
    expect(spool.pendingTurnEnds('sess-stale').map((p) => p.mark.atSize)).toEqual([2]);
  });

  it('counts nothing in a new marks file with the count kept for one that went some other way', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const mark = (atSize: number) => ({ slot: 'primary' as const, transcriptId: 'tx_' + 'g'.repeat(32), atSize });
    for (const size of [1, 2, 3]) spool.appendTurnEnd('sess-gone', mark(size));
    spool.consumeTurnEnds('sess-gone', spool.pendingTurnEnds('sess-gone')[1]);
    expect(readSessionState(spool.dir, 'sess-gone').markWater).toBe(3);
    // The file goes without the count being reset (removed by hand, or by a tool that knows nothing of the count).
    fs.unlinkSync(turnsFileOf(spool.dir, 'sess-gone'));
    spool.appendTurnEnd('sess-gone', mark(4));
    spool.appendTurnEnd('sess-gone', mark(5));
    expect(spool.pendingTurnEnds('sess-gone').map((p) => p.mark.atSize)).toEqual([4, 5]);
  });

  it('keeps every mark when a consume is cut off part-way, and its next marks file is read from the start', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const mark = (atSize: number) => ({ slot: 'primary' as const, transcriptId: 'tx_' + 'f'.repeat(32), atSize });
    spool.appendTurnEnd('sess-cut', mark(1));
    const [first] = spool.pendingTurnEnds('sess-cut');
    // The process dies writing the session's state: the write is cut off there, whatever came before it stands.
    const realRename = fs.renameSync;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to).endsWith(`${'sess-cut'}.state.json`)) throw new Error('killed while writing the state');
      return realRename(from, to);
    }) as typeof fs.renameSync;
    try {
      expect(() => spool.consumeTurnEnds('sess-cut', first)).toThrow('killed while writing the state');
    } finally {
      fs.renameSync = realRename;
    }
    // Nothing the cut-off consume did not record is gone: the mark is read again, which is harmless.
    expect(fs.existsSync(turnsFileOf(spool.dir, 'sess-cut'))).toBe(true);
    expect(spool.pendingTurnEnds('sess-cut').map((p) => p.mark.atSize)).toEqual([1]);
    spool.appendTurnEnd('sess-cut', mark(2));
    expect(spool.pendingTurnEnds('sess-cut').map((p) => p.mark.atSize)).toEqual([1, 2]);
  });

  it('loses only a line a write cut off, never the record after it, and still deletes the journal once delivered (G4a)', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-torn');
    spool.append('sess-torn', prompt(ctx, 'before the crash'));
    // What a writer killed mid-line, or stopped by a full disk, leaves behind.
    fs.appendFileSync(journal(spool, 'sess-torn'), '{"eventId":"0192a0c0-0000-7000-8000-000000000000","kind":"prom');
    spool.append('sess-torn', prompt(ctx, 'after the crash'));

    const lines = spool.readRecords('sess-torn');
    expect(lines.map((l) => (l === null ? null : (l as SpoolRecord).kind))).toEqual(['prompt', null, 'prompt']);
    const drained = await spool.drainSession('sess-torn', clientFor(rig), unboundedBudget());
    expect(drained).toMatchObject({ acked: 2, refused: 1, remaining: 0, endedBy: 'drained' });
    expect(rig.rows('events')).toBe(2);
    // The torn line is logged, and pins nothing: the journal is gone.
    expect(fs.existsSync(journal(spool, 'sess-torn'))).toBe(false);
    expect(spool.readRefused().entries.map((e) => e.reason)).toEqual(['unparsable spool line']);
  });

  it('loses no completed append across writers killed at random points mid-write (G4a)', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-killed';
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-journal-kill-')), 'writer.ts');
    fs.writeFileSync(script, [
      `import { MemberSpool } from ${JSON.stringify(path.join(SRC, 'member', 'spool.ts'))};`,
      `import { mintId, promptEvent } from ${JSON.stringify(path.join(SRC, 'member', 'envelope.ts'))};`,
      `const spool = new MemberSpool('proj_1', { mycoHome: process.env.MYCO_HOME });`,
      `const ctx = { agent: 'claude-code', sessionId: ${JSON.stringify(sessionId)}, stage: spool.stagerFor(${JSON.stringify(sessionId)}), version: 't' };`,
      `const text = 'x'.repeat(48_000);`,
      `for (;;) { spool.append(${JSON.stringify(sessionId)}, promptEvent(ctx, { promptId: mintId(), text })); process.stdout.write('+'); }`,
    ].join('\n'));
    let completed = 0;
    const KILLS = 30;
    for (let k = 0; k < KILLS; k++) {
      const child = spawn(process.execPath, [script], { env: { ...process.env, MYCO_HOME: mycoHome }, stdio: ['ignore', 'pipe', 'ignore'] });
      let done = 0;
      let started: () => void = () => {};
      const writing = new Promise<void>((r) => { started = r; });
      child.stdout.on('data', (chunk: Buffer) => { done += chunk.toString().length; started(); });
      // Killed at a random point once it is writing, so the kill lands mid-append as often as between appends.
      await Promise.race([writing, new Promise((r) => setTimeout(r, 10_000))]);
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 25)));
      child.kill('SIGKILL');
      await new Promise((r) => child.on('exit', r));
      completed += done;
    }
    spool.append(sessionId, prompt(ctxFor(spool, sessionId), 'the sentinel'));
    const lines = spool.readRecords(sessionId);
    const parsed = lines.filter((l) => l !== null);
    const torn = lines.length - parsed.length;
    // Every append a writer finished before it was killed is still a whole line, and the sentinel after them too.
    expect(parsed.length).toBeGreaterThanOrEqual(completed + 1);
    expect(torn).toBeLessThanOrEqual(KILLS);
    // Not vacuous: the writers did get appends in before they were killed.
    expect(completed).toBeGreaterThan(KILLS);
    expect((lines.at(-1) as SpoolRecord).payload.text).toBe('the sentinel');
  }, 120_000);
});

describe('the two lanes (G4f)', () => {
  /** A session with its start, a record the Deployment does not know (held, `unknown_kind`), and a transcript behind. */
  function heldSession(spool: MemberSpool, sessionId: string, start: OutboundEvent | null): string {
    const ctx = ctxFor(spool, sessionId);
    if (start) spool.append(sessionId, start);
    const future = prompt(ctx);
    (future.envelope as { kind: string }).kind = 'future.kind';
    spool.append(sessionId, future);
    const file = transcriptFile(sessionId, 3);
    updateSessionState(spool.dir, sessionId, (s) => {
      s.transcript = transcriptPointerFor(file, 'machine_1')!;
      s.agent = 'claude-code';
    });
    spool.markTranscriptBacklog(sessionId);
    return file;
  }

  it('ships a session\'s transcript though a record of its own is held, once its start is delivered', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-lanes');
    heldSession(spool, 'sess-lanes', sessionStartEvent(ctx, { branch: 'main', startedAt: Date.now(), originPath: '/work' }));
    const report = await drainBacklog(spool, clientFor(rig), unboundedBudget(), { force: true, machineId: 'machine_1' });
    const session = report.sessions.find((s) => s.sessionId === 'sess-lanes')!;
    expect(session.events).toMatchObject({ acked: 1, endedBy: 'refused', remaining: 1 });
    expect(session.transcripts).toMatchObject({ endedBy: 'done', shipped: 1 });
    expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-lanes' AND kind = 'transcript.segment'`).get()).toEqual({ n: 1 });
  });

  it('holds a transcript back while its session\'s start is still waiting, then ships it after the start', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-ordered');
    spool.append('sess-ordered', sessionStartEvent(ctx, { branch: 'main', startedAt: Date.now(), originPath: '/work' }));
    const file = transcriptFile('sess-ordered', 2);
    updateSessionState(spool.dir, 'sess-ordered', (s) => { s.transcript = transcriptPointerFor(file, 'machine_1')!; s.agent = 'claude-code'; });

    const early = await shipSessionTranscripts(ctx, spool, clientFor(rig), unboundedBudget(), { machineId: 'machine_1' });
    expect(early).toEqual({ shipped: 0, endedBy: 'ordered' });
    expect(spool.hasTranscriptBacklog('sess-ordered')).toBe(true);
    expect(rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 0 });

    await spool.drainSession('sess-ordered', clientFor(rig), unboundedBudget());
    const after = await shipSessionTranscripts(ctx, spool, clientFor(rig), unboundedBudget(), { machineId: 'machine_1' });
    expect(after).toEqual({ shipped: 1, endedBy: 'done' });
  });
});

describe('the two lanes past a held record (G4f)', () => {
  const startOf = (ctx: EnvelopeContext) => sessionStartEvent(ctx, { branch: 'main', startedAt: Date.now(), originPath: '/work' });
  const held = (ctx: EnvelopeContext) => {
    const future = prompt(ctx);
    (future.envelope as { kind: string }).kind = 'future.kind';
    return future;
  };
  const segments = (rig: MemberRig, sessionId: string) =>
    (rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND kind = 'transcript.segment'`).get(sessionId) as { n: number }).n;
  function behind(spool: MemberSpool, sessionId: string, lines = 3): string {
    const file = transcriptFile(sessionId, lines);
    updateSessionState(spool.dir, sessionId, (s) => { s.transcript = transcriptPointerFor(file, 'machine_1')!; s.agent = 'claude-code'; });
    spool.markTranscriptBacklog(sessionId);
    return file;
  }

  it('ships the transcript when a resume, compaction or clear writes another start behind a held record', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-compact');
    spool.append('sess-compact', startOf(ctx));
    spool.append('sess-compact', held(ctx));
    // The compaction's start: the same session again, behind the held record.
    spool.append('sess-compact', startOf(ctx));
    behind(spool, 'sess-compact');
    const walk = await drainBacklog(spool, clientFor(rig), unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(walk.sessions.find((s) => s.sessionId === 'sess-compact')!.events).toMatchObject({ acked: 1, endedBy: 'refused', remaining: 2 });
    expect(segments(rig, 'sess-compact')).toBe(1);
    // The Stop path ships the session's own transcript the same way.
    const file = transcriptFile('sess-compact-more', 2);
    fs.appendFileSync(readSessionState(spool.dir, 'sess-compact').transcript!.path, fs.readFileSync(file));
    expect(await shipSessionTranscripts(ctx, spool, clientFor(rig), unboundedBudget(), { machineId: 'machine_1' })).toEqual({ shipped: 1, endedBy: 'done' });
  });

  it('remembers the settled start once its journal is delivered and deleted, through a start behind a held record in the next', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-resumed');
    spool.append('sess-resumed', startOf(ctx));
    await spool.drainSession('sess-resumed', clientFor(rig), unboundedBudget());
    expect(fs.existsSync(journal(spool, 'sess-resumed'))).toBe(false);
    spool.append('sess-resumed', held(ctx));
    spool.append('sess-resumed', startOf(ctx));
    behind(spool, 'sess-resumed');
    expect(await shipSessionTranscripts(ctx, spool, clientFor(rig), unboundedBudget(), { machineId: 'machine_1' })).toEqual({ shipped: 1, endedBy: 'done' });
  });

  it('still holds the transcript for a first start that waits behind a held record', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-first');
    spool.append('sess-first', held(ctx));
    spool.append('sess-first', startOf(ctx));
    behind(spool, 'sess-first');
    await drainBacklog(spool, clientFor(rig), unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(segments(rig, 'sess-first')).toBe(0);
    expect(await shipSessionTranscripts(ctx, spool, clientFor(rig), unboundedBudget(), { machineId: 'machine_1' })).toEqual({ shipped: 0, endedBy: 'ordered' });
  });

  it('ships transcripts on a later walk inside the held record\'s wait, as on the walk that set it', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-wait');
    spool.append('sess-wait', startOf(ctx));
    spool.append('sess-wait', held(ctx));
    const file = behind(spool, 'sess-wait');
    const first = await drainBacklog(spool, clientFor(rig), unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(first.sessions[0].events).toMatchObject({ acked: 1, endedBy: 'refused' });
    expect(readSessionState(spool.dir, 'sess-wait').eventRetry!.at).toBeGreaterThan(Date.now());
    expect(segments(rig, 'sess-wait')).toBe(1);

    // More of the transcript, and a second walk before the wait is out: the events wait, the transcript does not.
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'later' } }) + '\n');
    spool.markTranscriptBacklog('sess-wait');
    const second = await drainBacklog(spool, clientFor(rig), unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(second.sessions[0].events).toMatchObject({ skipped: 'deferred' });
    expect(second.sessions[0].transcripts).toMatchObject({ endedBy: 'done', shipped: 1 });
    expect(segments(rig, 'sess-wait')).toBe(2);
    // A walk that only waited is no answer from the Deployment: the session is not counted as tried.
    expect(second.tried).toEqual([]);
  });
});

describe('turn-end marks are satisfied (G4j)', () => {
  const at = (pointer: ReturnType<typeof transcriptPointerFor>, atSize: number): TurnEndMark =>
    ({ t: 'te', _journal: JOURNAL_VERSION, slot: 'primary', transcriptId: pointer!.transcriptId, atSize, at: 1 });

  it('once the transcript reached the mark\'s size, or never will: replaced, refused, gone or cut short', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const file = transcriptFile('sess-sat', 4);
    const size = fs.statSync(file).size;
    const pointer = transcriptPointerFor(file, 'machine_1')!;
    const state = (over: Partial<typeof pointer> = {}) => ({ ...readSessionState(spool.dir, 'sess-sat'), transcript: { ...pointer, ...over } });

    expect(turnEndSatisfied(at(pointer, size), state())).toBe(false);
    expect(turnEndSatisfied(at(pointer, size), state({ nextOffset: size }))).toBe(true);
    expect(turnEndSatisfied(at(pointer, size), state({ transcriptId: 'tx_' + 'c'.repeat(32) }))).toBe(true);
    expect(turnEndSatisfied(at(pointer, size), state({ refused: 'transcript_rejected' }))).toBe(true);
    expect(turnEndSatisfied(at(pointer, size + 100), state())).toBe(true);
    fs.rmSync(file);
    expect(turnEndSatisfied(at(pointer, size), state())).toBe(true);
    expect(turnEndSatisfied({ ...at(pointer, size), slot: { subagent: '/nowhere.jsonl' } }, state())).toBe(true);
  });

  it('never ages out a plugin-written transcript a pointer has not shipped to its end', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const root = path.join(mycoHome, 'member', 'transcripts', 'opencode');
    fs.mkdirSync(root, { recursive: true });
    const behind = path.join(root, 'sess-behind.jsonl');
    const shipped = path.join(root, 'sess-shipped.jsonl');
    for (const file of [behind, shipped]) fs.writeFileSync(file, '{"type":"user"}\n');
    updateSessionState(spool.dir, 'sess-behind', (s) => { s.transcript = transcriptPointerFor(behind, 'machine_1')!; });
    updateSessionState(spool.dir, 'sess-shipped', (s) => {
      const pointer = transcriptPointerFor(shipped, 'machine_1')!;
      s.transcript = { ...pointer, nextOffset: fs.statSync(shipped).size };
    });
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    for (const file of [behind, shipped]) fs.utimesSync(file, old, old);
    expect(prunePluginTranscripts(Date.now(), process.env, mycoHome)).toBe(1);
    expect(fs.existsSync(behind)).toBe(true);
    expect(fs.existsSync(shipped)).toBe(false);
  });
});

describe('a session\'s lock file', () => {
  it('outlives its delivered journal, and is retired only with its state, under the lock, when no journal remains', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.append('sess-lock', prompt(ctxFor(spool, 'sess-lock')));
    const before = fs.statSync(bufferLockPath(spool.dir, 'sess-lock')).ino;
    await spool.drainSession('sess-lock', clientFor(rig), unboundedBudget());
    expect(fs.existsSync(journal(spool, 'sess-lock'))).toBe(false);
    // The state is still locked on this file, so the drain leaves it: the same file, never one made again.
    expect(fs.statSync(bufferLockPath(spool.dir, 'sess-lock')).ino).toBe(before);

    spool.append('sess-lock', prompt(ctxFor(spool, 'sess-lock'), 'a new turn'));
    expect(retireSessionFiles(spool.dir, 'sess-lock', () => true)).toBe(false);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-lock'))).toBe(true);

    await spool.drainSession('sess-lock', clientFor(rig), unboundedBudget());
    expect(retireSessionFiles(spool.dir, 'sess-lock', () => false)).toBe(false);
    expect(retireSessionFiles(spool.dir, 'sess-lock', () => true)).toBe(true);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-lock'))).toBe(false);
    // Gone on every platform: on Windows it is unlinked once the lock is let go, and nothing else holds it open here.
    expect(fs.existsSync(bufferLockPath(spool.dir, 'sess-lock'))).toBe(false);
  });
});

describe('a session\'s marks file', () => {
  it('is retired with the session\'s state, which its marks are read against', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.appendTurnEnd('sess-retire', { slot: 'primary', transcriptId: 'tx_' + 'd'.repeat(32), atSize: 3 });
    expect(fs.existsSync(turnsFileOf(spool.dir, 'sess-retire'))).toBe(true);
    expect(retireSessionFiles(spool.dir, 'sess-retire', () => true)).toBe(true);
    expect(fs.existsSync(turnsFileOf(spool.dir, 'sess-retire'))).toBe(false);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-retire'))).toBe(false);
  });
});

describe('a member file kept to its owner', () => {
  it('is judged by its POSIX mode, and passes on Windows, which reports none (#1550)', () => {
    expect(isPrivateMode(0o100600, 'darwin')).toBe(true);
    expect(isPrivateMode(0o100644, 'linux')).toBe(false);
    // Every writable file reads as 0666 on Windows: refusing it there read every membership and session state as absent.
    expect(isPrivateMode(0o100666, 'win32')).toBe(true);
  });
});
