/**
 * What drives a native Deployment's own recovery artifacts, and what it refuses to conclude.
 *
 * The child that produces an artifact is a stand-in here: what is under test is the driver — where an attempt is
 * pinned, when a second one may begin, what a failure leaves visible, how long a stalled attempt is carried on,
 * and which artifacts retention may release. The artifact itself is the canonical writer's, proven in its own
 * suite and against the real binary in the runtime harness.
 *
 * The one thing these tests hold hardest: an absent in-memory child is never evidence that an attempt stopped.
 */
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  artifactsRoot, attempts, CONTINUATION_LIMIT, destinationOwned, keptArtifacts, LocalArtifacts, statusOf,
  type AttemptRecord, type LocalArtifactsOptions,
} from '@myco/server/local-artifacts.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { resolveLocalPaths } from '@myco/server/local.js';
import { availabilityOf } from '@myco-server-worker/core/recovery-schedule.js';
import type { CommandResult, CommandRunner, RunOptions } from '@myco/server/runner.js';
import { CommandCancelled, CommandFailed } from '@myco/server/runner.js';

const DEPLOYMENT = 'dep_fixture_0000000000000001';

/** A Deployment whose volume names itself, without serving it: the id is all this owner reads from the volume. */
function deployment() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifacts-'));
  const paths = resolveLocalPaths(path.join(home, 'home'));
  fs.mkdirSync(paths.root, { recursive: true });
  // A volume that names itself, which is all this owner reads from one.
  const db = new Database(paths.databasePath, { create: true });
  try {
    db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.query('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('deployment_id', DEPLOYMENT);
  } finally { db.close(); }
  const root = artifactsRoot(paths, DEPLOYMENT);
  return { home, paths, root, remove: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** A child that answers however a test wants, and records exactly what it was asked to run. */
function runner(answer: (args: readonly string[], options?: RunOptions) => Promise<CommandResult>) {
  const asked: Array<{ command: string; args: readonly string[]; options?: RunOptions }> = [];
  return {
    asked,
    runner: {
      run: async (command: string, args: readonly string[], options?: RunOptions) => {
        asked.push({ command, args, options });
        return answer(args, options);
      },
    } satisfies CommandRunner,
  };
}

const completes = async (): Promise<CommandResult> => ({ code: 0, stdout: 'Verified data artifact written', stderr: '' });
/**
 * A child that answers nothing until it is withdrawn, as one still producing an artifact does not.
 *
 * Withdrawal rejects, which is what the canonical runner does once it has ended the child's process group.
 */
const hangs = (_args: readonly string[], options?: RunOptions): Promise<CommandResult> => new Promise<CommandResult>((_resolve, reject) => {
  options?.signal?.addEventListener('abort', () => { reject(new CommandCancelled('myco', [], 'ended')); }, { once: true });
});

const artifacts = (options: LocalArtifactsOptions = {}) => new LocalArtifacts(options);

/** What the canonical writer would have written, so this owner reads a real manifest rather than a mock of one. */
const manifest = (directory: string, status: 'snapshot' | 'content' | 'complete', extra: Record<string, unknown> = {}): void => {
  fs.mkdirSync(path.join(directory, 'blobs', 'proj_1'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'recovery.json'), JSON.stringify({
    format: 'myco-recovery/2', status, source: { target: 'local', locator: '/volume' },
    startedAt: new Date().toISOString(), snapshot: { database: { bytes: 4_096 }, blobCount: 1 }, ...extra,
  }));
  // An artifact is more than its manifest: the database it holds, and one file per object it names.
  fs.writeFileSync(path.join(directory, 'myco.sqlite'), 'x'.repeat(64));
  fs.writeFileSync(path.join(directory, 'blobs', 'proj_1', 'a'.repeat(64)), 'blob');
};

const record = (root: string, startedAt: number, held: Partial<AttemptRecord> = {}): void => {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${startedAt}.attempt.json`), JSON.stringify({
    startedAt, holdToken: `hold-${startedAt}`, startedBy: 'schedule', continuations: 1, ...held,
  }));
};

it('pins the attempt on disk before the child runs, and answers a hold token it already carries', async () => {
  const d = deployment();
  const spawned = runner(hangs);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 5_000 });
    const admitted = await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' });
    expect([admitted.attempt, admitted.stage, admitted.form]).toEqual([5_000, 'copy', 'artifact']);
    // The pin is the attempt: a record and its directory exist before the child has written anything at all.
    expect(fs.existsSync(path.join(d.root, '5000.attempt.json'))).toBe(true);
    expect(fs.existsSync(path.join(d.root, '5000'))).toBe(true);
    expect(attempts(d.root).map((one) => [one.startedAt, one.status, one.record.holdToken]))
      .toEqual([[5_000, null, 'hold-a']]);
    // The same token asks for nothing new, and neither does a second admission while one is going.
    expect((await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' })).attempt).toBe(5_000);
    expect((await owner.admit({ holdToken: 'hold-b', startedBy: 'schedule' })).attempt).toBe(5_000);
    expect(spawned.asked.length).toBe(1);
    expect(spawned.asked[0]!.args).toEqual(['server', 'backup', '--target', 'local', '--to', path.join(d.root, '5000')]);
  } finally { d.remove(); }
});

it('runs the child with a deadline and a withdrawal signal, so nothing it starts outlives its owner unbidden', async () => {
  const d = deployment();
  const spawned = runner(hangs);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 1 });
    await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' });
    const options = spawned.asked[0]!.options!;
    expect([typeof options.timeoutMs, options.signal === undefined]).toEqual(['number', false]);
    expect(options.signal!.aborted).toBe(false);
    await owner.stop();
    expect(options.signal!.aborted).toBe(true);
  } finally { d.remove(); }
});

it('carries the running code into the child, entry script and all, rather than assuming a compiled binary', async () => {
  const d = deployment();
  const spawned = runner(hangs);
  try {
    // A checkout run is `bun <entry>`; the child must be the same code, which is what the resolved argv carries.
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: '/bin/bun', args: ['/repo/src/index.ts'] }, now: () => 7 });
    await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' });
    expect([spawned.asked[0]!.command, spawned.asked[0]!.args[0]]).toEqual(['/bin/bun', '/repo/src/index.ts']);
  } finally { d.remove(); }
});

it('leaves a refused attempt visible and does not start another, so the interval decides the next one', async () => {
  const d = deployment();
  const refuses = runner(async () => { throw new CommandFailed('myco', [], { code: 1, stdout: '', stderr: 'the volume is in use' }); });
  try {
    const owner = artifacts({ paths: d.paths, runner: refuses.runner, command: { path: 'myco', args: [] }, now: () => 9_000 });
    await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' });
    // The child's answer lands after the admission, so the record settles on the next read.
    await Bun.sleep(20);
    const held = attempts(d.root);
    // The refusal is recorded and its own words stay on disk for whoever looks.
    expect(held[0]!.record.lastRefusal?.refusal).toBe('artifact_refused');
    expect(held[0]!.record.lastRefusal?.detail).toContain('the volume is in use');
    // It is not the attempt's verdict, though: a child of an earlier process may hold this destination's lock and
    // be finishing the very artifact this ask was refused for. So the attempt still reads as going, not failed,
    // and no message travels in the status.
    const status = statusOf(held[0]);
    expect([status.stage, status.error]).toEqual(['copy', null]);
    expect(JSON.stringify(status)).not.toContain('the volume is in use');
    // Nothing new begins here either: due is the schedule's decision, not a refusal's.
    expect((await owner.admit({ holdToken: 'hold-b', startedBy: 'schedule' })).attempt).toBe(9_000);
  } finally { d.remove(); }
});

it('carries on an attempt that stopped without finishing, up to a bound, then leaves it failed', async () => {
  const d = deployment();
  const refuses = runner(async () => { throw new CommandFailed('myco', [], { code: 1, stdout: '', stderr: 'stopped' }); });
  try {
    const owner = artifacts({ paths: d.paths, runner: refuses.runner, command: { path: 'myco', args: [] }, now: () => 3_000 });
    // An attempt whose child wrote a snapshot and stopped: pinned, part-written, not given up on.
    record(d.root, 3_000, { continuations: 1, holdToken: 'hold-a' });
    manifest(path.join(d.root, '3000'), 'content');
    for (let pass = 0; pass < CONTINUATION_LIMIT + 3; pass += 1) {
      await owner.resumeAttempt();
      await Bun.sleep(10);
    }
    // It is asked again only while its continuations are under the bound: a Deployment does not spend every wake
    // on an artifact that will not be produced.
    expect(refuses.asked.length).toBeLessThanOrEqual(CONTINUATION_LIMIT);
    const held = attempts(d.root)[0]!;
    expect(held.record.continuations).toBeGreaterThanOrEqual(CONTINUATION_LIMIT);
    expect(held.record.givenUp).toBe(true);
    // Only then is it failed, and only then does its classifier reach the status.
    expect([statusOf(held).stage, statusOf(held).error]).toEqual(['failed', 'artifact_refused']);
  } finally { d.remove(); }
});

it('asks nothing of an attempt whose child this process never started, and concludes nothing from its absence', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    // The shape an abrupt end of a Deployment leaves: an attempt pinned and part-written by a child this process
    // knows nothing about, which may still be running and still holding the destination's own lock.
    record(d.root, 2_000, { continuations: 1 });
    manifest(path.join(d.root, '2000'), 'snapshot');
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 4_000 });
    // It is read as the attempt it is — still going — so the hold it carries is open and nothing new is admitted.
    expect(await owner.settleHold('hold-2000')).toEqual({ state: 'open', attempt: 2_000, stage: 'copy' });
    expect((await owner.admit({ holdToken: 'hold-new', startedBy: 'schedule' })).attempt).toBe(2_000);
    // Carrying it on asks the canonical writer against the same directory; the destination's lock, not this
    // owner, decides whether that ask does anything.
    await owner.resumeAttempt();
    expect(spawned.asked.map((one) => one.args.at(-1))).toEqual([path.join(d.root, '2000')]);
  } finally { d.remove(); }
});

it('settles a hold against the attempt carrying it, and retires a token no attempt carries', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    record(d.root, 1_000, { holdToken: 'hold-complete' });
    manifest(path.join(d.root, '1000'), 'complete');
    record(d.root, 2_000, { holdToken: 'hold-failed', givenUp: true, lastRefusal: { refusal: 'artifact_refused', detail: 'stopped', at: 1 } });
    expect(await owner.settleHold('hold-complete')).toEqual({ state: 'closed', attempt: 1_000, stage: 'complete' });
    expect(await owner.settleHold('hold-failed')).toEqual({ state: 'closed', attempt: 2_000, stage: 'failed' });
    expect(await owner.settleHold('hold-nobody-carries')).toEqual({ state: 'retired' });
  } finally { d.remove(); }
});

it('names nothing from a volume it cannot read, rather than failing every wake on it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifacts-unreadable-'));
  try {
    const paths = resolveLocalPaths(path.join(home, 'home'));
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.databasePath, 'this is not a database');
    const owner = artifacts({ paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    expect(owner.admission.ready).toBe(false);
    expect(await owner.status()).toMatchObject({ attempt: null, stage: 'idle' });
    expect(await owner.pendingStagingPrunes({ keep: 2, protect: [] })).toBe(0);
    await owner.resumeAttempt();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('reports a complete artifact as the verified form a restore consumes, and says what else a restore needs', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    record(d.root, 8_000, { holdToken: 'hold-a' });
    manifest(path.join(d.root, '8000'), 'complete');
    const status = await owner.status();
    expect([status.stage, status.form, status.recoverable]).toEqual(['complete', 'artifact', false]);
    const available = availabilityOf(status);
    expect(available.state).toBe('artifact');
    if (available.state !== 'artifact') throw new Error('unreachable');
    expect(available.at).toBe(path.join(d.root, '8000'));
    expect(available.needs).toContain('wrapping key');
    // The staging sentence is never borrowed for an artifact.
    expect(available.needs).not.toContain('materialize');
  } finally { d.remove(); }
});

it('releases older complete artifacts, keeping the newest, the active one, the uncertain one and the held one', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    for (const startedAt of [1_000, 2_000, 3_000, 4_000]) {
      record(d.root, startedAt, { holdToken: `hold-${startedAt}` });
      manifest(path.join(d.root, String(startedAt)), 'complete');
    }
    // An attempt still going, one whose manifest cannot be read, and one whose hold is open.
    record(d.root, 5_000);
    manifest(path.join(d.root, '5000'), 'content');
    record(d.root, 900);
    fs.mkdirSync(path.join(d.root, '900'), { recursive: true });
    fs.writeFileSync(path.join(d.root, '900', 'recovery.json'), '{ this is not json');
    record(d.root, 800, { holdToken: 'hold-open' });
    manifest(path.join(d.root, '800'), 'complete');
    fs.writeFileSync(path.join(d.root, '800', '.recovery-hold.json'), JSON.stringify({ token: 'hold-open' }));

    // What retention owes: the two releasable artifacts, and the held one whose hold is still open.
    const policy = { keep: 2, protect: ['hold-open'] };
    expect(await owner.pendingStagingPrunes(policy)).toBe(3);
    const report = await owner.pruneStagings({ ...policy, budget: 50 });
    expect([report.releasedStagings, report.refused]).toEqual([2, null]);
    // The two oldest complete artifacts went; everything the policy protects stands.
    expect(fs.existsSync(path.join(d.root, '1000'))).toBe(false);
    expect(fs.existsSync(path.join(d.root, '2000'))).toBe(false);
    expect(fs.existsSync(path.join(d.root, '4000', 'recovery.json'))).toBe(true);
    // Each released artifact leaves a tombstone: the hold token it was admitted under, and its own start.
    const tombstones = attempts(d.root).filter((one) => one.record.released === true);
    expect(tombstones.map((one) => [one.startedAt, one.record.holdToken]))
      .toEqual([[1_000, 'hold-1000'], [2_000, 'hold-2000']]);
    // A tombstone holds nothing to recover from, and its token admits no second attempt.
    expect(statusOf(tombstones[0]).staged).toBe(null);
    expect((await owner.admit({ holdToken: 'hold-1000', startedBy: 'schedule' })).attempt).toBe(1_000);
    // Everything the policy keeps is still an attempt with its files.
    expect(attempts(d.root).filter((one) => one.record.released !== true).map((one) => one.startedAt))
      .toEqual([800, 900, 3_000, 4_000, 5_000]);
  } finally { d.remove(); }
});

it('keeps the last good artifact at every policy value, and bounds what one pass releases', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    for (const startedAt of [1_000, 2_000, 3_000]) {
      record(d.root, startedAt, { holdToken: `hold-${startedAt}` });
      manifest(path.join(d.root, String(startedAt)), 'complete');
    }
    // A budget of one file releases one file and no artifact: the pass is bounded by what it deletes.
    const first = await owner.pruneStagings({ keep: 1, protect: [], budget: 1 });
    expect([first.releasedFiles, first.releasedStagings, first.pending]).toEqual([1, 0, 2]);
    // The artifact it started on is still selectable, with its remaining files still there.
    expect(fs.existsSync(path.join(d.root, '1000'))).toBe(true);
    // Enough budget for the rest, and a policy value below the floor still keeps the last good artifact.
    const second = await owner.pruneStagings({ keep: 0, protect: [], budget: 50 });
    expect([second.releasedStagings, second.pending, second.refused]).toEqual([2, 0, null]);
    const live = attempts(d.root).filter((one) => one.record.released !== true);
    expect(live.map((one) => one.startedAt)).toEqual([3_000]);
    expect(fs.existsSync(path.join(d.root, '3000', 'recovery.json'))).toBe(true);
  } finally { d.remove(); }
});

it('reconciles a complete artifact whose hold release was lost, and never releases that artifact', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] } });
    record(d.root, 6_000, { holdToken: 'hold-unsettled' });
    manifest(path.join(d.root, '6000'), 'complete');
    fs.writeFileSync(path.join(d.root, '6000', '.recovery-hold.json'), JSON.stringify({ token: 'hold-unsettled' }));
    record(d.root, 7_000, { holdToken: 'hold-b' });
    manifest(path.join(d.root, '7000'), 'complete');

    // The hold is still open on the Deployment, so its own writer is asked again: that is what settles a release
    // whose answer was lost. The artifact itself stays.
    const report = await owner.pruneStagings({ keep: 1, protect: ['hold-unsettled'], budget: 5 });
    expect([report.releasedStagings, report.refused]).toEqual([0, null]);
    expect(spawned.asked.map((one) => one.args.at(-1))).toEqual([path.join(d.root, '6000')]);
    expect(fs.existsSync(path.join(d.root, '6000', 'recovery.json'))).toBe(true);
  } finally { d.remove(); }
});

it('refuses to admit on a machine whose volume names no Deployment, and says why', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-artifacts-absent-'));
  try {
    const paths = resolveLocalPaths(path.join(home, 'home'));
    expect(fs.existsSync(paths.databasePath)).toBe(false);
    const owner = artifacts({ paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    const admission = owner.admission;
    expect(admission.ready).toBe(false);
    if (admission.ready) throw new Error('unreachable');
    expect(admission.reason).toContain('volume');
    expect(await owner.status()).toMatchObject({ attempt: null, stage: 'idle', form: 'artifact' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

/**
 * The destination's own lock is the authority on whether an artifact is still being produced.
 *
 * A child of an earlier Deployment process survives an abrupt end of that process and keeps that lock. Its
 * refusal of this owner's ask says the attempt is alive — never that it failed — and concluding otherwise would
 * settle the hold that defers deletion of everything its snapshot named while it is still copying them.
 */
it('GATE: never gives up on, or settles the hold of, an attempt whose destination is owned', async () => {
  const d = deployment();
  const refuses = runner(async () => { throw new CommandFailed('myco', [], { code: 1, stdout: '', stderr: 'another backup owns this recovery destination' }); });
  try {
    const owner = artifacts({ paths: d.paths, runner: refuses.runner, command: { path: 'myco', args: [] }, now: () => 3_000 });
    record(d.root, 3_000, { continuations: 1, holdToken: 'hold-a' });
    manifest(path.join(d.root, '3000'), 'content');
    // The real lock, taken the way the canonical writer takes it.
    const owned = LifecycleLock.acquire(path.join(d.root, '3000', '.recovery.lock'), { command: 'another producer' });
    expect(owned.acquired).toBe(true);
    if (!owned.acquired) throw new Error('unreachable');
    try {
      expect(destinationOwned(path.join(d.root, '3000'))).toBe(true);
      for (let pass = 0; pass < CONTINUATION_LIMIT + 3; pass += 1) {
        await owner.resumeAttempt();
        await Bun.sleep(10);
      }
      const held = attempts(d.root)[0]!;
      expect(held.record.givenUp).toBe(undefined);
      expect(statusOf(held).stage).toBe('copy');
      // The hold stays open, so deletion on the source stays deferred while that producer works.
      expect(await owner.settleHold('hold-a')).toEqual({ state: 'open', attempt: 3_000, stage: 'copy' });
      // And retention never selects it.
      expect(await owner.pendingStagingPrunes({ keep: 1, protect: [] })).toBe(0);
    } finally { owned.lock.release(); }

    // With nothing owning the destination, the same bound settles it and the hold closes.
    await owner.resumeAttempt();
    await Bun.sleep(20);
    const settled = attempts(d.root)[0]!;
    expect(settled.record.givenUp).toBe(true);
    expect(await owner.settleHold('hold-a')).toEqual({ state: 'closed', attempt: 3_000, stage: 'failed' });
  } finally { d.remove(); }
});

/**
 * An attempt's own record is written atomically, and a record that cannot be read is uncertain rather than absent:
 * its directory and the hold it was admitted under may both be real.
 */
it('GATE: reads a corrupt attempt record as uncertain, and never as no attempt at all', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 5_000 });
    record(d.root, 1_000, { holdToken: 'hold-a' });
    manifest(path.join(d.root, '1000'), 'content');
    // A record whose write was interrupted, which is the only attempt this Deployment has.
    fs.writeFileSync(path.join(d.root, '1000.attempt.json'), '{"startedAt":1000,"holdTok');

    const held = attempts(d.root);
    expect([held.length, held[0]!.uncertain, held[0]!.startedAt]).toEqual([1, true, 1_000]);
    // It is an attempt, so the producer is not idle and no fresh attempt is admitted over it.
    const status = await owner.status();
    expect([status.attempt, status.stage]).toEqual([1_000, 'copy']);
    expect((await owner.admit({ holdToken: 'hold-new', startedBy: 'schedule' })).attempt).toBe(1_000);
    expect(spawned.asked).toEqual([]);
    // Nothing is given up on it, and retention never selects it.
    await owner.resumeAttempt();
    expect(attempts(d.root)[0]!.record.givenUp).toBe(undefined);
    expect(await owner.pendingStagingPrunes({ keep: 1, protect: [] })).toBe(0);
    expect(await owner.pruneStagings({ keep: 1, protect: [], budget: 50 })).toMatchObject({ releasedStagings: 0 });
    expect(fs.existsSync(path.join(d.root, '1000', 'recovery.json'))).toBe(true);
    // Nor is the fence over it released: a token this owner cannot place is never retired while one is uncertain.
    expect(await owner.settleHold('hold-a')).toEqual({ state: 'open', attempt: 1_000, stage: 'copy' });
  } finally { d.remove(); }
});

it('writes an attempt record atomically, so an interrupted write leaves the previous one readable', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(hangs).runner, command: { path: 'myco', args: [] }, now: () => 6_000 });
    await owner.admit({ holdToken: 'hold-a', startedBy: 'schedule' });
    // Whatever files the write leaves behind, the record itself parses: it is renamed into place, never appended.
    const stray = fs.readdirSync(d.root).filter((entry) => entry.includes('.attempt.json'));
    expect(stray).toEqual(['6000.attempt.json']);
    expect(JSON.parse(fs.readFileSync(path.join(d.root, '6000.attempt.json'), 'utf8')).holdToken).toBe('hold-a');
    await owner.stop();
  } finally { d.remove(); }
});

/**
 * A released artifact leaves a tombstone, and a tombstone is settled: it holds no files, it is not an attempt in
 * flight, and it must never stand between this Deployment and its next backup.
 */
it('GATE: admits the next attempt over a released artifact, and answers the tombstone for its own token', async () => {
  const d = deployment();
  const spawned = runner(hangs);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 9_000 });
    record(d.root, 1_000, { holdToken: 'hold-1000' });
    manifest(path.join(d.root, '1000'), 'complete');
    record(d.root, 2_000, { holdToken: 'hold-2000' });
    manifest(path.join(d.root, '2000'), 'complete');
    await owner.pruneStagings({ keep: 1, protect: [], budget: 50 });
    const tombstone = attempts(d.root).find((one) => one.startedAt === 1_000)!;
    expect([tombstone.record.released, tombstone.record.terminal]).toEqual([true, 'complete']);
    // The stage its record kept, with no manifest left to read it from, and nothing to recover from.
    expect([statusOf(tombstone).stage, statusOf(tombstone).staged]).toEqual(['complete', null]);

    // A fresh admission is a fresh attempt: a tombstone is not an attempt in flight.
    const admitted = await owner.admit({ holdToken: 'hold-new', startedBy: 'schedule' });
    expect([admitted.attempt, admitted.stage]).toEqual([9_000, 'copy']);
    expect(spawned.asked.length).toBe(1);
    // And the released attempt's own token still answers that attempt, so it admits nothing twice.
    expect((await owner.admit({ holdToken: 'hold-1000', startedBy: 'schedule' })).attempt).toBe(1_000);
    expect(await owner.settleHold('hold-1000')).toEqual({ state: 'closed', attempt: 1_000, stage: 'complete' });
    await owner.stop();
  } finally { d.remove(); }
});

it('GATE: stops calling an artifact available before it deletes anything of it, and finishes without its manifest', async () => {
  const d = deployment();
  try {
    const owner = artifacts({ paths: d.paths, runner: runner(completes).runner, command: { path: 'myco', args: [] } });
    record(d.root, 1_000, { holdToken: 'hold-1000' });
    manifest(path.join(d.root, '1000'), 'complete');
    record(d.root, 2_000, { holdToken: 'hold-2000' });
    manifest(path.join(d.root, '2000'), 'complete');

    // A budget that runs out part-way through the oldest artifact.
    const first = await owner.pruneStagings({ keep: 1, protect: [], budget: 2 });
    expect([first.releasedFiles, first.releasedStagings]).toEqual([2, 0]);
    const partial = attempts(d.root).find((one) => one.startedAt === 1_000)!;
    // Its release is recorded, its manifest is the first file to go, and it offers nothing to recover from.
    expect(partial.record.pruning).toBe(true);
    expect(fs.existsSync(path.join(d.root, '1000', 'recovery.json'))).toBe(false);
    expect(statusOf(partial).staged).toBe(null);
    expect(availabilityOf(statusOf(partial)).state).toBe('none');

    // The next pass carries on from the record alone, with no manifest left to read.
    const second = await owner.pruneStagings({ keep: 1, protect: [], budget: 50 });
    expect([second.releasedStagings, second.pending]).toEqual([1, 0]);
    expect(fs.existsSync(path.join(d.root, '1000'))).toBe(false);
    expect(attempts(d.root).find((one) => one.startedAt === 1_000)!.record.released).toBe(true);
  } finally { d.remove(); }
});

/**
 * An attempt this owner knows of but cannot describe is uncertain however its record went missing: torn, foreign,
 * or gone while its directory still stands. Its fence is not released on its behalf, and no record is invented
 * for it.
 */
it('GATE: treats an attempt whose record is gone, but whose directory stands, as uncertain', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 5_000 });
    record(d.root, 1_000, { holdToken: 'hold-a' });
    manifest(path.join(d.root, '1000'), 'content');
    fs.rmSync(path.join(d.root, '1000.attempt.json'));

    const held = attempts(d.root);
    expect([held.length, held[0]!.uncertain, held[0]!.startedAt]).toEqual([1, true, 1_000]);
    // The token that attempt was admitted under is not retired: nothing here established what became of it.
    expect(await owner.settleHold('hold-a')).toEqual({ state: 'open', attempt: 1_000, stage: 'copy' });
    // Nothing is written in its place, and nothing new is admitted over it.
    await owner.resumeAttempt();
    expect(fs.existsSync(path.join(d.root, '1000.attempt.json'))).toBe(false);
    expect((await owner.admit({ holdToken: 'hold-new', startedBy: 'schedule' })).attempt).toBe(1_000);
    expect(spawned.asked).toEqual([]);
    // And retention leaves it alone, whatever the policy says.
    expect(await owner.pruneStagings({ keep: 1, protect: [], budget: 50 })).toMatchObject({ releasedStagings: 0 });
  } finally { d.remove(); }
});

/**
 * A complete artifact whose own hold was never released is work this Deployment owes, and it must be able to wake
 * for it once the admission's own hold is settled — the registry settles that one, and only asking the writer
 * again settles this one.
 */
it('GATE: counts a complete artifact with an open hold as work owed, bounded, and reconciles it', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] }, now: () => 9_000 });
    record(d.root, 1_000, { holdToken: 'hold-a', continuations: 1 });
    manifest(path.join(d.root, '1000'), 'complete');
    fs.writeFileSync(path.join(d.root, '1000', '.recovery-hold.json'), JSON.stringify({ token: 'hold-a' }));

    // Nothing is releasable — one complete artifact, kept — and yet there is work owed, so the Deployment stays
    // eligible to wake for it.
    const policy = { keep: 2, protect: ['hold-a'] };
    expect(await owner.pendingStagingPrunes(policy)).toBe(1);
    await owner.pruneStagings({ ...policy, budget: 50 });
    expect(spawned.asked.map((one) => one.args.at(-1))).toEqual([path.join(d.root, '1000')]);

    // Bounded: past the same count a production attempt gets, it stops holding the Deployment awake and stays
    // visible for an operator to settle.
    fs.writeFileSync(path.join(d.root, '1000.attempt.json'), JSON.stringify({
      startedAt: 1_000, holdToken: 'hold-a', startedBy: 'schedule', continuations: CONTINUATION_LIMIT,
    }));
    expect(await owner.pendingStagingPrunes(policy)).toBe(0);
    // The hold is still open on the Deployment, and the artifact is still there: nothing was concluded about it.
    expect(fs.existsSync(path.join(d.root, '1000', 'recovery.json'))).toBe(true);
  } finally { d.remove(); }
});

it('owes nothing for an operator hold that belongs to no artifact of its own', async () => {
  const d = deployment();
  const spawned = runner(completes);
  try {
    const owner = artifacts({ paths: d.paths, runner: spawned.runner, command: { path: 'myco', args: [] } });
    record(d.root, 1_000, { holdToken: 'hold-a' });
    manifest(path.join(d.root, '1000'), 'complete');
    // An operator's own backup, taken to a destination of their choosing: this Deployment's artifacts name none
    // of it, and nothing here reconciles or releases it.
    const policy = { keep: 2, protect: ['an-operator-backup-elsewhere'] };
    expect(await owner.pendingStagingPrunes(policy)).toBe(0);
    await owner.pruneStagings({ ...policy, budget: 50 });
    expect(spawned.asked).toEqual([]);
  } finally { d.remove(); }
});

/**
 * What a destroyed Deployment leaves behind, which its own removal names: the artifacts live outside the volume
 * and outlive it, so they are what is left to restore it from.
 */
it('names the complete artifacts kept on this machine, and nothing else', () => {
  const d = deployment();
  try {
    expect(keptArtifacts(d.paths, DEPLOYMENT)).toBe(null);
    record(d.root, 1_000, { holdToken: 'hold-a' });
    manifest(path.join(d.root, '1000'), 'complete');
    record(d.root, 2_000, { holdToken: 'hold-b' });
    manifest(path.join(d.root, '2000'), 'content');
    record(d.root, 3_000, { holdToken: 'hold-c', released: true, terminal: 'complete' });
    // One complete artifact: an attempt still running is not one, and a released tombstone holds nothing.
    expect(keptArtifacts(d.paths, DEPLOYMENT)).toEqual({ root: d.root, complete: 1 });
    expect(keptArtifacts(d.paths, null)).toBe(null);
  } finally { d.remove(); }
});
