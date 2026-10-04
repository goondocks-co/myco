/**
 * Retention keeps unacknowledged journals and their payloads deliverable at
 * every age. Delivered session state and unreferenced staged bytes may age out.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUFFER_QUARANTINE_DIRNAME } from '@myco/capture/buffer.js';
import { longestDeclaredHookTimeoutMs, unboundedBudget } from '@myco/member/budget.js';
import { MEMBER_PROTOCOL, MEMBER_SESSION_STATE_RETENTION_MS, MEMBER_SPOOL_QUARANTINE_MS, MEMBER_SPOOL_QUARANTINE_PRUNE_MS, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { attachmentEvent, mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { applySpoolRetention, lastAckAt, pruneDeliveredSessionState, sweepStagedBlobs, unacknowledgedSince } from '@myco/member/retention.js';
import { drainBacklog, sessionTried } from '@myco/member/backlog.js';
import { MemberSpool } from '@myco/member/spool.js';
import { readSessionState, sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { ServerClient } from '@myco/member/transport.js';
import { memberRig, tempMycoHome } from './helpers/server.js';

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
const origErr = process.stderr.write.bind(process.stderr);
const stderrLines: string[] = [];
beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stderrLines.length = 0;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const ctxFor = (spool: MemberSpool, sessionId: string): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: '2.0.0-test' });
const DAY = 86_400_000;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/myco/src/member');

describe('spool retention', () => {
  for (const fault of ['protocol', 'unreadable', 'deployment'] as const) {
    it(`delivers old and fresh capture after a ${fault} hold, even beyond both retention windows`, async () => {
      const rig = await memberRig();
      const spool = new MemberSpool('proj_1', { mycoHome });
      const sessionId = `sess-held-${fault}`;
      const t0 = Date.now() - MEMBER_SPOOL_QUARANTINE_MS - DAY;
      const journal = path.join(spool.dir, `${sessionId}.jsonl`);
      const ctx = ctxFor(spool, sessionId);
      let repair = () => {};
      let fetch = rig.fetch;
      if (fault === 'unreadable') {
        const source = spool.stagerFor(sessionId)(new Uint8Array([137, 80, 78, 71, 9]), 'image/png');
        spool.appendAndRecord(sessionId, [attachmentEvent(ctx, { blobSource: source, attachmentId: mintId() })], undefined, t0);
        const saved = path.join(mycoHome, 'held-payload');
        fs.renameSync(source.path, saved);
        fs.mkdirSync(source.path);
        repair = () => { fs.rmdirSync(source.path); fs.renameSync(saved, source.path); };
      } else {
        spool.appendAndRecord(sessionId, [promptEvent(ctx, { promptId: mintId(), text: 'old' })], undefined, t0);
        if (fault === 'protocol') {
          fs.writeFileSync(journal, fs.readFileSync(journal, 'utf-8').replace(`"_memberProtocol":${MEMBER_PROTOCOL}`, '"_memberProtocol":999'));
          repair = () => fs.writeFileSync(journal, fs.readFileSync(journal, 'utf-8').replace('"_memberProtocol":999', `"_memberProtocol":${MEMBER_PROTOCOL}`));
        } else {
          let refusing = true;
          fetch = (input, init) => {
            if (refusing && new URL(new Request(input, init).url).pathname === '/events') {
              return Promise.resolve(Response.json({ persisted: false, code: 'no_project', reason: 'project temporarily unavailable' }, { headers: { [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL) } }));
            }
            return rig.fetch(input, init);
          };
          repair = () => { refusing = false; };
        }
      }

      const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, fetch);
      const held = await spool.drainSession(sessionId, client, unboundedBudget(), { now: () => t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY, force: true });
      expect(held.remaining).toBe(1);
      expect(['protocol_mismatch', 'unreadable', 'refused']).toContain(held.endedBy);
      expect(sessionTried(held)).toBe(true);
      spool.appendAndRecord(sessionId, [promptEvent(ctx, { promptId: mintId(), text: 'fresh' })], undefined, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY);
      const tried = { tried: [sessionId] };
      expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY, tried).quarantined).toEqual([]);
      expect(spool.depth(sessionId)).toBe(2);
      expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + MEMBER_SPOOL_QUARANTINE_PRUNE_MS + DAY, tried).pruned).toBe(0);
      expect(spool.depth(sessionId)).toBe(2);

      repair();
      const delivered = await spool.drainSession(sessionId, client, unboundedBudget(), { now: () => Date.now(), force: true });
      expect(delivered).toMatchObject({ acked: 2, remaining: 0, endedBy: 'drained' });
      expect(rig.rows('events')).toBe(2);
      expect(spool.sessionIds()).toEqual([]);
      expect((await spool.drainSession(sessionId, client, unboundedBudget(), { force: true })).acked).toBe(0);
      expect(rig.rows('events')).toBe(2);
    });
  }

  it('keeps an unacknowledged journal active beyond both age windows', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.append('sess-old', promptEvent(ctxFor(spool, 'sess-old'), { promptId: mintId(), text: 'old' }));
    const file = path.join(spool.dir, 'sess-old.jsonl');
    const t0 = Date.now();
    // Under the cap: untouched.
    expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS - DAY)).toEqual({ quarantined: [], pruned: 0, prunedStates: 0, releasedBlobs: 0, prunedTranscripts: 0 });
    expect(fs.existsSync(file)).toBe(true);
    // A spool no walk has reached is only waiting, whatever its age.
    expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY).quarantined).toEqual([]);
    const r = applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY, { tried: ['sess-old'] });
    expect(r.quarantined).toEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toContain('"old"');
    expect(spool.sessionIds()).toEqual(['sess-old']);
    expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + MEMBER_SPOOL_QUARANTINE_PRUNE_MS + DAY).pruned).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('keeps the high-water and unconsumed turn-end marks while an old journal receives new events', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-q');
    const mark = (atSize: number) => ({ slot: 'primary' as const, transcriptId: 'tx_' + 'q'.repeat(32), atSize });
    for (const text of ['one', 'two', 'three']) spool.append('sess-q', promptEvent(ctx, { promptId: mintId(), text }));
    spool.appendTurnEnd('sess-q', mark(10));
    spool.appendTurnEnd('sess-q', mark(20));
    // The event lane is part-way through the journal, the first mark consumed, and the transcript still behind.
    updateSessionState(spool.dir, 'sess-q', (state) => { state.highWater = 2; });
    spool.consumeTurnEnds('sess-q', spool.pendingTurnEnds('sess-q')[0]);
    spool.markTranscriptBacklog('sess-q');
    const t0 = Date.now();
    expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY, { tried: ['sess-q'] }).quarantined).toEqual([]);
    expect(readSessionState(spool.dir, 'sess-q')).toMatchObject({ highWater: 2, markWater: 2 });

    // The same journal retains its earlier records and the remaining mark.
    spool.append('sess-q', promptEvent(ctx, { promptId: mintId(), text: 'after' }));
    expect(spool.depth('sess-q')).toBe(2);
    expect(spool.pendingTurnEnds('sess-q').map((m) => m.mark.atSize)).toEqual([20]);
  });

  it('keeps an active session through partial delivery and releases a fully acknowledged journal', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx = ctxFor(spool, 'sess-live');
    for (let i = 0; i < 3; i++) spool.append('sess-live', promptEvent(ctx, { promptId: mintId(), text: `p${i}` }));
    let calls = 0;
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      calls += 1;
      if (calls === 2) throw new Error('ECONNRESET');
      return rig.fetch(input, init);
    });
    const far = Date.now() + MEMBER_SPOOL_QUARANTINE_MS + DAY;
    // One ack lands far in the future, then the pass ends on retry: the state's updatedAt is "now".
    await spool.drainSession('sess-live', client, unboundedBudget(), { now: () => far, force: true });
    expect(spool.depth('sess-live')).toBe(2);
    expect(applySpoolRetention(spool, far + DAY)).toEqual({ quarantined: [], pruned: 0, prunedStates: 0, releasedBlobs: 0, prunedTranscripts: 0 });
    expect(fs.existsSync(path.join(spool.dir, 'sess-live.jsonl'))).toBe(true);
    await spool.drainSession('sess-live', client, unboundedBudget(), { now: () => far + DAY, force: true });
    expect(spool.sessionIds()).toEqual([]);
    expect(applySpoolRetention(spool, far + 2 * DAY)).toEqual({ quarantined: [], pruned: 0, prunedStates: 0, releasedBlobs: 0, prunedTranscripts: 0 });
  });

  it('keeps the state of a session whose transcript bytes are undelivered, and lets it go once its transcript file is gone', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const t0 = Date.now();
    const file = path.join(fs.mkdtempSync(path.join(mycoHome, 'tx-')), 'sess-tx.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } })}\n`);
    spool.appendAndRecord('sess-tx', [promptEvent(ctxFor(spool, 'sess-tx'), { promptId: mintId(), text: 'tx' })], (state) => {
      state.transcript = { path: file, transcriptId: 'tx-kept', inode: Number(fs.statSync(file).ino), nextOffset: 0, parsedSize: 0 };
    }, t0);
    await spool.drainSession('sess-tx', client, unboundedBudget(), { now: () => t0, force: true });
    expect(spool.sessionIds()).toEqual([]);
    expect(spool.transcriptBacklogIds()).toEqual(['sess-tx']);
    const late = t0 + MEMBER_SESSION_STATE_RETENTION_MS + DAY;
    expect(applySpoolRetention(spool, late, { delivered: true }).prunedStates).toBe(0);
    expect(readSessionState(spool.dir, 'sess-tx').transcript?.path).toBe(file);

    fs.rmSync(file);
    const report = await drainBacklog(spool, client, unboundedBudget(), { force: true, machineId: 'machine_1' });
    expect(report).toEqual({ endedBy: 'done', tried: [], sessions: [{ sessionId: 'sess-tx' }] });
    expect(spool.transcriptBacklogIds()).toEqual([]);
    expect(applySpoolRetention(spool, late, { delivered: true }).prunedStates).toBe(1);
  });

  it('never prunes a state whose transcript is behind its file, even once its backlog mark is gone', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const t0 = Date.now();
    const file = path.join(fs.mkdtempSync(path.join(mycoHome, 'tx-')), 'sess-unmarked.jsonl');
    fs.writeFileSync(file, 'x\n');
    spool.appendAndRecord('sess-unmarked', [promptEvent(ctxFor(spool, 'sess-unmarked'), { promptId: mintId(), text: 'u' })], (state) => {
      state.transcript = { path: file, transcriptId: 'tx-unmarked', inode: Number(fs.statSync(file).ino), nextOffset: 0, parsedSize: 0 };
    }, t0);
    await spool.drainSession('sess-unmarked', client, unboundedBudget(), { now: () => t0, force: true });
    spool.clearTranscriptBacklog('sess-unmarked');
    expect(applySpoolRetention(spool, t0 + MEMBER_SESSION_STATE_RETENTION_MS + DAY, { delivered: true }).prunedStates).toBe(0);
    expect(readSessionState(spool.dir, 'sess-unmarked').transcript?.path).toBe(file);
  });

  it('keeps a stuck session and its transcript state in the active backlog', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const t0 = Date.now();
    const file = path.join(fs.mkdtempSync(path.join(mycoHome, 'tx-')), 'sess-stuck.jsonl');
    fs.writeFileSync(file, 'x\n');
    spool.appendAndRecord('sess-stuck', [promptEvent(ctxFor(spool, 'sess-stuck'), { promptId: mintId(), text: 'stuck' })], (state) => {
      state.transcript = { path: file, transcriptId: 'tx-stuck', inode: Number(fs.statSync(file).ino), nextOffset: 0, parsedSize: 0 };
    }, t0);
    const r = applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY, { tried: ['sess-stuck'] });
    expect(r.quarantined).toEqual([]);
    expect(spool.sessionIds()).toEqual(['sess-stuck']);
    const state = readSessionState(spool.dir, 'sess-stuck');
    expect({ path: state.transcript?.path, highWater: state.highWater }).toEqual({ path: file, highWater: 0 });
    expect(spool.transcriptBacklogIds()).toEqual(['sess-stuck']);
  });

  it('prunes the state of a session delivered long ago only after a drain that delivered everything, and never one still holding records', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const t0 = Date.now();
    spool.append('sess-done', promptEvent(ctxFor(spool, 'sess-done'), { promptId: mintId(), text: 'done' }));
    await spool.drainSession('sess-done', client, unboundedBudget(), { now: () => t0, force: true });
    expect(spool.sessionIds()).toEqual([]);
    expect(spool.stateSessionIds()).toEqual(['sess-done']);
    // A session still holding undelivered records keeps its state whatever its age.
    spool.appendAndRecord('sess-held', [promptEvent(ctxFor(spool, 'sess-held'), { promptId: mintId(), text: 'held' })], undefined, t0);
    // Inside the window: kept. Past it without a delivering drain: kept. Past it after one: pruned.
    const late = t0 + MEMBER_SESSION_STATE_RETENTION_MS + DAY;
    expect(applySpoolRetention(spool, t0 + DAY, { delivered: true }).prunedStates).toBe(0);
    expect(applySpoolRetention(spool, late).prunedStates).toBe(0);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-done'))).toBe(true);
    expect(applySpoolRetention(spool, late, { delivered: true }).prunedStates).toBe(1);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-done'))).toBe(false);
    expect(fs.existsSync(sessionStatePath(spool.dir, 'sess-held'))).toBe(true);
    // A delivered session that was written to inside the window is a live one.
    spool.append('sess-live', promptEvent(ctxFor(spool, 'sess-live'), { promptId: mintId(), text: 'live' }));
    await spool.drainSession('sess-live', client, unboundedBudget(), { now: () => late, force: true });
    updateSessionState(spool.dir, 'sess-live', () => {}, late);
    expect(pruneDeliveredSessionState(spool, late + DAY)).toBe(0);
    expect(readSessionState(spool.dir, 'sess-live').updatedAt).toBe(late);
  });

  it('measures the last acknowledgement while keeping a session that is still appending', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const t0 = Date.now();
    spool.appendAndRecord('sess-offline', [promptEvent(ctxFor(spool, 'sess-offline'), { promptId: mintId(), text: 'first' })], undefined, t0);
    // Still writing 40 days later, still never acknowledged: the spool file's
    // mtime is minutes old, the last acknowledgement is 40 days away.
    const late = t0 + MEMBER_SPOOL_QUARANTINE_MS + 10 * DAY;
    spool.appendAndRecord('sess-offline', [promptEvent(ctxFor(spool, 'sess-offline'), { promptId: mintId(), text: 'later' })], undefined, late);
    expect(fs.statSync(path.join(spool.dir, 'sess-offline.jsonl')).mtimeMs).toBeGreaterThan(t0);
    expect(unacknowledgedSince(spool, 'sess-offline')).toBe(t0);
    expect(applySpoolRetention(spool, late, { tried: ['sess-offline'] }).quarantined).toEqual([]);
    expect(spool.depth('sess-offline')).toBe(2);
  });

  it('an acknowledgement moves the clock forward; nothing else does', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const t0 = Date.now();
    spool.appendAndRecord('sess-ack', [promptEvent(ctxFor(spool, 'sess-ack'), { promptId: mintId(), text: 'p' })], undefined, t0);
    expect(lastAckAt(spool, 'sess-ack')).toBe(0);
    const acked = t0 + MEMBER_SPOOL_QUARANTINE_MS - DAY;
    await spool.drainSession('sess-ack', new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch), unboundedBudget(), { now: () => acked, force: true });
    expect(lastAckAt(spool, 'sess-ack')).toBe(acked);
  });

  it('releases staged blob bytes once no live hook could still name them, and sweeps what a stopped drain left', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const source = spool.stagerFor('sess-blob')(new Uint8Array([137, 80, 78, 71]), 'image/png');
    spool.append('sess-blob', attachmentEvent(ctxFor(spool, 'sess-blob'), { blobSource: source, attachmentId: mintId() }));
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);

    // Freshly staged: the drain acknowledges the record but leaves the bytes,
    // because a hook still running could append another record naming them.
    await spool.drainSession('sess-blob', client, unboundedBudget(), { force: true });
    expect(fs.existsSync(source.path)).toBe(true);
    expect(applySpoolRetention(spool).releasedBlobs).toBe(0);

    // Past the longest timeout a hook can declare, nobody can still name them.
    const settled = (Date.now() - longestDeclaredHookTimeoutMs() - 60_000) / 1000;
    fs.utimesSync(source.path, settled, settled);
    expect(applySpoolRetention(spool).releasedBlobs).toBe(1);
    expect(fs.existsSync(source.path)).toBe(false);
  });

  it('never reclaims bytes another session staged and has not committed yet: the attachment still uploads', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    // Session A's Stop is mid-parse: the bytes are staged, the record and its
    // `attachmentKeys` receipt have not been committed.
    const source = spool.stagerFor('sess-A')(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), 'image/png');

    // Session B's probing hook runs retention over the whole project.
    const swept = applySpoolRetention(spool);
    expect(swept.releasedBlobs).toBe(0);
    expect(fs.existsSync(source.path)).toBe(true);

    // A commits, and the record it committed can still be delivered.
    spool.append('sess-A', attachmentEvent(ctxFor(spool, 'sess-A'), { blobSource: source, attachmentId: mintId() }));
    const result = await spool.drainSession('sess-A', new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch), unboundedBudget(), { force: true });
    expect({ acked: result.acked, refused: result.refused }).toEqual({ acked: 1, refused: 0 });
    expect(rig.rows('attachments')).toBe(1);
    expect(spool.readRefused().entries).toEqual([]);
  });

  it('re-staging a sha restarts its grace: the mtime says when a hook last named the bytes, not when they were first written', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const stage = spool.stagerFor('sess-restage');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = stage(bytes, 'application/octet-stream');
    // Age the file past the grace, as a long-lived session would.
    const stale = (Date.now() - longestDeclaredHookTimeoutMs() - 60_000) / 1000;
    fs.utimesSync(source.path, stale, stale);
    expect(fs.statSync(source.path).mtimeMs).toBeLessThan(Date.now() - longestDeclaredHookTimeoutMs());

    // A second hook stages the same content: the bytes are reusable, the clock is not.
    const again = stage(bytes, 'application/octet-stream');
    expect(again.path).toBe(source.path);
    expect(fs.statSync(source.path).mtimeMs).toBeGreaterThan(Date.now() - longestDeclaredHookTimeoutMs());
    expect(applySpoolRetention(spool).releasedBlobs).toBe(0);
    expect(fs.existsSync(source.path)).toBe(true);
  });

  it('a bare file left directly under blobs/ by a project-wide-dir build is reclaimed under the same grace', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const legacy = path.join(spool.blobsDir, 'a'.repeat(64));
    fs.mkdirSync(spool.blobsDir, { recursive: true });
    fs.writeFileSync(legacy, 'bytes', { mode: 0o600 });
    // Fresh: still inside the grace, so it stays.
    expect(applySpoolRetention(spool).releasedBlobs).toBe(0);
    const stale = (Date.now() - longestDeclaredHookTimeoutMs() - 60_000) / 1000;
    fs.utimesSync(legacy, stale, stale);
    expect(applySpoolRetention(spool).releasedBlobs).toBe(1);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('keeps staged bytes for an old unacknowledged attachment until it delivers', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const t0 = Date.now();
    const source = spool.stagerFor('sess-q')(new Uint8Array([137, 80, 78, 71, 9]), 'image/png');
    spool.appendAndRecord('sess-q', [attachmentEvent(ctxFor(spool, 'sess-q'), { blobSource: source, attachmentId: mintId() })], undefined, t0);

    const late = t0 + MEMBER_SPOOL_QUARANTINE_MS + MEMBER_SPOOL_QUARANTINE_PRUNE_MS + DAY;
    expect(applySpoolRetention(spool, late, { tried: ['sess-q'] }).quarantined).toEqual([]);
    expect(fs.readFileSync(source.path)).toEqual(Buffer.from([137, 80, 78, 71, 9]));
    expect(spool.depth('sess-q')).toBe(1);
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await spool.drainSession('sess-q', client, unboundedBudget(), { force: true })).toMatchObject({ acked: 1, remaining: 0 });
    expect(rig.rows('attachments')).toBe(1);
  });

  it('does not sweep staged bytes while their active journal is unreadable', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-unreadable-journal';
    const source = spool.stagerFor(sessionId)(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
    spool.append(sessionId, attachmentEvent(ctxFor(spool, sessionId), { blobSource: source, attachmentId: mintId() }));
    const old = (Date.now() - longestDeclaredHookTimeoutMs() - DAY) / 1000;
    fs.utimesSync(source.path, old, old);
    const journal = path.join(spool.dir, `${sessionId}.jsonl`);
    fs.chmodSync(journal, 0o000);
    try {
      expect(applySpoolRetention(spool).releasedBlobs).toBe(0);
      expect(fs.existsSync(source.path)).toBe(true);
    } finally {
      fs.chmodSync(journal, 0o600);
    }
  });

  it('keeps every staged byte when a readable journal contains a torn record', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-torn-journal';
    const orphan = spool.stagerFor(sessionId)(new Uint8Array([5, 6, 7, 8]), 'application/octet-stream');
    spool.append(sessionId, promptEvent(ctxFor(spool, sessionId), { promptId: mintId(), text: 'complete' }));
    const journal = path.join(spool.dir, `${sessionId}.jsonl`);
    fs.appendFileSync(journal, '{"_blobSource":');
    const old = (Date.now() - longestDeclaredHookTimeoutMs() - DAY) / 1000;
    fs.utimesSync(orphan.path, old, old);
    expect(spool.readRecordsOrNull(sessionId)).toMatchObject({ readable: true, records: [expect.any(Object), null] });
    expect(sweepStagedBlobs(spool, spool.sessionIds())).toBe(0);
    expect(fs.existsSync(orphan.path)).toBe(true);
    fs.writeFileSync(journal, fs.readFileSync(journal, 'utf-8').split('\n')[0] + '\n');
    expect(sweepStagedBlobs(spool, spool.sessionIds())).toBe(1);
    expect(fs.existsSync(orphan.path)).toBe(false);
  });

  it('does not delete a byte refreshed by a concurrent session stager', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const sessionId = 'sess-racing-stage';
    const source = spool.stagerFor(sessionId)(new Uint8Array([9, 8, 7, 6]), 'application/octet-stream');
    spool.append(sessionId, promptEvent(ctxFor(spool, sessionId), { promptId: mintId(), text: 'live' }));
    const old = (Date.now() - longestDeclaredHookTimeoutMs() - DAY) / 1000;
    fs.utimesSync(source.path, old, old);
    const marker = path.join(mycoHome, 'stager-finished');
    const spoolModule = path.resolve(SRC, 'spool.ts');
    const script = `import fs from 'node:fs'; import { MemberSpool } from ${JSON.stringify(spoolModule)}; new MemberSpool('proj_1', { mycoHome: ${JSON.stringify(mycoHome)} }).stagerFor(${JSON.stringify(sessionId)})(new Uint8Array([9, 8, 7, 6]), 'application/octet-stream'); fs.writeFileSync(${JSON.stringify(marker)}, 'done');`;
    const realStat = fs.statSync.bind(fs);
    let child: ReturnType<typeof spawn> | undefined;
    let finished: Promise<number | null> | undefined;
    const paused = spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const stat = realStat(file, ...args as []);
      if (String(file) !== source.path || child !== undefined) return stat;
      child = spawn(process.execPath, ['-e', script], { env: process.env, stdio: 'ignore' });
      finished = new Promise<number | null>((resolve, reject) => { child!.on('error', reject); child!.on('exit', resolve); });
      const deadline = Date.now() + 400;
      while (!fs.existsSync(marker) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      return stat;
    }) as typeof fs.statSync);
    try {
      sweepStagedBlobs(spool, spool.sessionIds());
      expect(child).toBeDefined();
      expect(await finished).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.existsSync(source.path)).toBe(true);
    } finally {
      paused.mockRestore();
      if (child?.exitCode === null) child.kill('SIGTERM');
    }
  });

  it('preserves quarantined journals and staged bytes already written by an earlier retention pass', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const archived = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME, 'sess-archived.jsonl');
    const blob = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME, 'blobs', 'sess-archived', 'a'.repeat(64));
    fs.mkdirSync(path.dirname(blob), { recursive: true });
    fs.writeFileSync(archived, '{"eventId":"ev-archived"}\n');
    fs.writeFileSync(blob, 'payload');
    const old = (Date.now() - MEMBER_SPOOL_QUARANTINE_PRUNE_MS - DAY) / 1000;
    fs.utimesSync(archived, old, old);
    expect(applySpoolRetention(spool).pruned).toBe(0);
    expect(fs.readFileSync(archived, 'utf-8')).toContain('ev-archived');
    expect(fs.readFileSync(blob, 'utf-8')).toBe('payload');
  });

  it('does not reuse cleanStaleBuffers (1.4 age-delete) anywhere under member/', () => {
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect({ file: path.relative(SRC, file), hit: fs.readFileSync(file, 'utf-8').includes('cleanStaleBuffers') }).toEqual({ file: path.relative(SRC, file), hit: false });
    }
  });
});
