/**
 * Retention: an un-acknowledged spool is never age-deleted; 30 days without
 * an acknowledgement quarantines it (`quarantineBufferFile`), 60 days prunes
 * the quarantined copy (`pruneQuarantinedBuffers`); a session still being
 * acknowledged is never quarantined — the clock is the acknowledgement
 * itself, so a session still appending while permanently offline still ages
 * out; staged blob bytes are released when their record is acknowledged and
 * swept when a drain never finished; `cleanStaleBuffers` (1.4's age-delete
 * policy) is not reused anywhere under `member/**`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUFFER_QUARANTINE_DIRNAME } from '@myco/capture/buffer.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { MEMBER_SPOOL_QUARANTINE_MS, MEMBER_SPOOL_QUARANTINE_PRUNE_MS } from '@myco/member/constants.js';
import { attachmentEvent, mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { applySpoolRetention, lastAckAt, unacknowledgedSince } from '@myco/member/retention.js';
import { MemberSpool } from '@myco/member/spool.js';
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
  it('quarantines a spool with no acknowledgement for 30 days, never deletes it, and prunes the quarantined copy after 60 days', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.append('sess-old', promptEvent(ctxFor(spool, 'sess-old'), { promptId: mintId(), text: 'old' }));
    const file = path.join(spool.dir, 'sess-old.jsonl');
    const t0 = Date.now();
    // Under the cap: untouched.
    expect(applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS - DAY)).toEqual({ quarantined: [], pruned: 0, releasedBlobs: 0 });
    expect(fs.existsSync(file)).toBe(true);
    // Past the cap: moved, not deleted; the bytes survive.
    const r = applySpoolRetention(spool, t0 + MEMBER_SPOOL_QUARANTINE_MS + DAY);
    expect(r.quarantined).toHaveLength(1);
    const quarantined = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME, 'sess-old.jsonl');
    expect(r.quarantined[0]).toBe(quarantined);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(quarantined, 'utf-8')).toContain('"old"');
    expect(fs.statSync(path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME)).mode & 0o777).toBe(0o700);
    expect(stderrLines.join('')).toContain('quarantined');
    // Pruning reads the file's own age: age it past 60 days on disk.
    const past = (Date.now() - MEMBER_SPOOL_QUARANTINE_PRUNE_MS - DAY) / 1000;
    fs.utimesSync(quarantined, past, past);
    expect(applySpoolRetention(spool, Date.now())).toEqual({ quarantined: [], pruned: 1, releasedBlobs: 0 });
    expect(fs.existsSync(quarantined)).toBe(false);
  });

  it('a session that keeps acknowledging is never quarantined, and a fully acknowledged spool needs no retention', async () => {
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
    expect(applySpoolRetention(spool, far + DAY)).toEqual({ quarantined: [], pruned: 0, releasedBlobs: 0 });
    expect(fs.existsSync(path.join(spool.dir, 'sess-live.jsonl'))).toBe(true);
    await spool.drainSession('sess-live', client, unboundedBudget(), { now: () => far + DAY, force: true });
    expect(spool.sessionIds()).toEqual([]);
    expect(applySpoolRetention(spool, far + 2 * DAY)).toEqual({ quarantined: [], pruned: 0, releasedBlobs: 0 });
  });

  it('measures the acknowledgement, not the file: a session still appending while permanently offline is quarantined', () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const t0 = Date.now();
    spool.appendAndRecord('sess-offline', [promptEvent(ctxFor(spool, 'sess-offline'), { promptId: mintId(), text: 'first' })], undefined, t0);
    // Still writing 40 days later, still never acknowledged: the spool file's
    // mtime is minutes old, the last acknowledgement is 40 days away.
    const late = t0 + MEMBER_SPOOL_QUARANTINE_MS + 10 * DAY;
    spool.appendAndRecord('sess-offline', [promptEvent(ctxFor(spool, 'sess-offline'), { promptId: mintId(), text: 'later' })], undefined, late);
    expect(fs.statSync(path.join(spool.dir, 'sess-offline.jsonl')).mtimeMs).toBeGreaterThan(t0);
    expect(unacknowledgedSince(spool, 'sess-offline')).toBe(t0);
    expect(applySpoolRetention(spool, late).quarantined).toHaveLength(1);
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

  it('releases staged blob bytes when their record is acknowledged, and sweeps what a stopped drain left', async () => {
    const rig = await memberRig();
    const spool = new MemberSpool('proj_1', { mycoHome });
    const stage = spool.stagerFor('sess-blob');
    const source = stage(new Uint8Array([137, 80, 78, 71]), 'image/png');
    expect(fs.existsSync(source.path)).toBe(true);
    spool.append('sess-blob', attachmentEvent(ctxFor(spool, 'sess-blob'), { blobSource: source, attachmentId: mintId() }));
    await spool.drainSession('sess-blob', new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch), unboundedBudget(), { force: true });
    expect(fs.existsSync(source.path)).toBe(false);

    // Bytes staged by a hook whose drain never ran are collected by the sweep.
    const orphan = spool.stagerFor('sess-orphan')(new Uint8Array([1, 2, 3]), 'application/octet-stream');
    expect(applySpoolRetention(spool).releasedBlobs).toBe(1);
    expect(fs.existsSync(orphan.path)).toBe(false);
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
