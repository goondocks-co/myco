/**
 * Backup, restore, update, rotate, adopt — asserted by argv and by the one
 * correctness property a reviewer cannot see by reading the commands.
 *
 * The database runs in WAL mode, so `myco.sqlite` alone is not the database:
 * committed pages sit in the `-wal` sidecar until a checkpoint. A backup that
 * copies the one file restores silently and is missing every commit since the
 * last checkpoint. That is the failure this file exists to prevent, and it is
 * asserted against real SQLite rather than by reading the argv.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupDeployment,
  restoreDeployment,
  updateDeployment,
  rotateSecrets,
  adoptDeployment,
  materializeBundle,
  resolveDeploymentPaths,
  pinnedVersion,
  UpdateRolledBack,
  COMPOSE_PROJECT,
} from '@myco/server/deployment.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { LIVE_RUNS_QUERY, LIVE_RUNS_RETRY_MS, LIVE_RUN_POLL_MS, LiveRunsUnreadable } from '@myco/server/live-runs.js';
import { LIVE_RUNS_QUERY as SERVER_LIVE_RUNS_QUERY } from '@myco-server-worker/platform/bun/server-main.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'myco-dataops-')); roots.push(d); return d; };

let calls: { command: string; args: string[] }[] = [];
/** The live-runs read answers an empty Deployment; every other command succeeds saying nothing. */
const answer = (args: readonly string[]) => (args.includes('--live-runs') ? '[]' : '');
const runner = (): CommandRunner => ({
  async run(command, args) { calls.push({ command, args: [...args] }); return { code: 0, stdout: answer(args), stderr: '' }; },
});
beforeEach(() => { calls = []; });

/** A clock a test drives: the read's retry pause moves it rather than spending the time. */
const clock = (start = 0) => {
  let at = start;
  return { now: () => at, sleep: async (ms: number) => { at += ms; }, get at() { return at; } };
};

const paths = () => resolveDeploymentPaths(scratch());
/** Every argv this run produced, flattened, for substring assertions. */
const argvText = () => calls.map((c) => c.args.join(' ')).join('\n');

describe('WAL correctness — the property a file copy silently breaks', () => {
  it('VACUUM INTO carries commits still sitting in the -wal sidecar', () => {
    const dir = scratch();
    const live = join(dir, 'live.sqlite');

    const db = new Database(live, { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE t (v TEXT)');
    db.query('INSERT INTO t (v) VALUES (?)').run('committed-before-checkpoint');

    // A naive copy of the main file, taken while the WAL holds the commit.
    const naive = join(dir, 'naive.sqlite');
    writeFileSync(naive, readFileSync(live));

    const snapshot = join(dir, 'snapshot.sqlite');
    db.query('VACUUM INTO ?').run(snapshot);
    db.close();

    const fromSnapshot = new Database(snapshot);
    expect((fromSnapshot.query('SELECT COUNT(*) c FROM t').get() as { c: number }).c).toBe(1);
    fromSnapshot.close();

    // The control: the naive copy either has no table or no row. Either way it
    // is not the database, and it opens without complaint.
    const fromNaive = new Database(naive);
    let naiveRows = -1;
    try {
      naiveRows = (fromNaive.query('SELECT COUNT(*) c FROM t').get() as { c: number }).c;
    } catch { naiveRows = -1; }
    fromNaive.close();
    expect(naiveRows).not.toBe(1);
  });
});

describe('backup', () => {
  it('snapshots with VACUUM INTO, copies both, and removes the snapshot', async () => {
    const p = paths();
    const dest = join(scratch(), 'backup');
    await backupDeployment({ paths: p, runner: runner(), destination: dest });

    expect(existsSync(dest)).toBe(true);
    expect(argvText()).toContain('VACUUM INTO');
    expect(argvText()).toContain(`server:/data/.backup-snapshot.sqlite ${join(dest, 'myco.sqlite')}`);
    expect(argvText()).toContain(`server:/data/blobs ${join(dest, 'blobs')}`);
    // Leaving it behind doubles the volume on every backup.
    expect(argvText()).toContain('rm -f /data/.backup-snapshot.sqlite');
  });

  it('scopes every command to this stack', async () => {
    const p = paths();
    await backupDeployment({ paths: p, runner: runner(), destination: join(scratch(), 'b') });
    for (const call of calls) expect(call.args).toContain(COMPOSE_PROJECT);
  });
});

describe('restore', () => {
  const backupDir = () => {
    const dir = join(scratch(), 'from');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'myco.sqlite'), 'snapshot');
    return dir;
  };

  it('refuses a directory that holds no snapshot', async () => {
    await expect(restoreDeployment({ paths: paths(), runner: runner(), source: scratch() }))
      .rejects.toThrow(/not a Deployment backup/);
  });

  it('stops before copying and starts after', async () => {
    const p = paths();
    await restoreDeployment({ paths: p, runner: runner(), source: backupDir() });

    const verbs = calls.filter((c) => !c.args.includes('--live-runs'))
      .map((c) => c.args.find((a) => ['stop', 'cp', 'run', 'up'].includes(a)));
    expect(verbs[0]).toBe('stop');
    expect(verbs.at(-1)).toBe('up');
  });

  it('waits for what is running before it stops, and a run arriving mid-wait is left to the grace', async () => {
    const p = paths();
    const lines: string[] = [];
    const live = JSON.stringify([{ id: 'run_a', task: 'digest-only', status: 'running', started_at: 0, run_context: JSON.stringify({ timeoutSeconds: 1800 }) }]);
    let answers = [live, '[]'];
    const scripted: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return { code: 0, stdout: args.includes('--live-runs') ? answers.shift() ?? '[]' : '', stderr: '' };
      },
    };

    await restoreDeployment({ paths: p, runner: scripted, source: backupDir(), report: (l) => lines.push(l), clock: clock() });

    // A restore replaces the database a live run writes its own ending into.
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.findIndex((a) => a.includes('--live-runs'))).toBe(0);
    expect(flat.findIndex((a) => a.includes('--live-runs'))).toBeLessThan(flat.findIndex((a) => a.includes('stop')));
    expect(lines).toContain('Waiting for a running task: digest-only, started 0 sec ago, budget 30 min');
    expect(lines).toContain('Nothing is running; the deploy proceeds.');
  });

  it('--no-drain asks the container nothing at all', async () => {
    const p = paths();
    await restoreDeployment({ paths: p, runner: runner(), source: backupDir(), noDrain: true, report: () => undefined });
    expect(calls.filter((c) => c.args.includes('--live-runs'))).toHaveLength(0);
    expect(argvText()).toContain('stop');
  });

  it('GATE: clears the WAL sidecar, which describes the replaced database', async () => {
    const p = paths();
    await restoreDeployment({ paths: p, runner: runner(), source: backupDir() });
    // Left in place it is replayed over the snapshot, undoing the restore.
    expect(argvText()).toContain('rm -f /data/myco.sqlite-wal /data/myco.sqlite-shm');
  });
});

describe('update', () => {
  it('reads what is running, then pulls, then recreates, and does not migrate itself', async () => {
    const p = paths();
    materializeBundle(p);
    await updateDeployment({ paths: p, runner: runner(), report: () => undefined });

    expect(calls[0]!.args).toContain('--live-runs');
    expect(calls[1]!.args).toContain('pull');
    expect(calls[2]!.args).toEqual(expect.arrayContaining(['up', '--detach', '--wait']));
    // Migration is the container entrypoint's, before the listener binds.
    expect(argvText()).not.toContain('--migrate-only');
  });

  it('GATE: a failed pull leaves the bundle unpinned rather than lying', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_VERSION: '2.0.0' });
    const failing: CommandRunner = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return args.includes('pull')
          ? { code: 1, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: answer(args), stderr: '' };
      },
    };

    await expect(updateDeployment({ paths: p, runner: failing, version: '2.0.1' })).rejects.toThrow();

    // The running container is still 2.0.0; a bundle claiming 2.0.1 would have
    // the file and the container disagreeing with nothing to arbitrate.
    expect(readFileSync(p.envFile, 'utf8')).toContain('MYCO_VERSION=2.0.0');
  });

  it('pins a requested version in the env file the bundle reads', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_PORT: '8787' });
    await updateDeployment({ paths: p, runner: runner(), version: '2.0.1' });

    const env = readFileSync(p.envFile, 'utf8');
    expect(env).toContain('MYCO_VERSION=2.0.1');
    expect(env).toContain('MYCO_PORT=8787');
  });

  it('replaces a pinned version rather than appending a second line', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_VERSION: '2.0.0' });
    await updateDeployment({ paths: p, runner: runner(), version: '2.0.1' });

    const lines = readFileSync(p.envFile, 'utf8').split('\n').filter((l) => l.startsWith('MYCO_VERSION='));
    expect(lines).toEqual(['MYCO_VERSION=2.0.1']);
  });
});

describe('rotate', () => {
  it('replaces the generated secrets and force-recreates', async () => {
    const p = paths();
    materializeBundle(p);
    const before = readFileSync(join(p.secretsDir, 'session_secret'), 'utf8');

    const rotated = await rotateSecrets({ paths: p, runner: runner() });

    expect(rotated).toContain('session_secret');
    expect(readFileSync(join(p.secretsDir, 'session_secret'), 'utf8')).not.toBe(before);
    expect(argvText()).toContain('--force-recreate');
  });

  it('leaves an operator-supplied secret alone', async () => {
    const p = paths();
    materializeBundle(p);
    writeFileSync(join(p.secretsDir, 'github_client_secret'), 'operator-value');

    await rotateSecrets({ paths: p, runner: runner() });

    expect(readFileSync(join(p.secretsDir, 'github_client_secret'), 'utf8')).toBe('operator-value');
  });
});

describe('adopt', () => {
  it('writes a bundle without disturbing existing secrets', async () => {
    const p = paths();
    materializeBundle(p);
    const before = readFileSync(join(p.secretsDir, 'secret_wrap_key'), 'utf8');

    await adoptDeployment({ paths: p, runner: runner() });

    // Reissuing keys is not what adopting a stack means.
    expect(readFileSync(join(p.secretsDir, 'secret_wrap_key'), 'utf8')).toBe(before);
    expect(existsSync(p.composeFile)).toBe(true);
  });
});

describe('rollback', () => {
  /** Fails whichever compose verb is named, succeeds at everything else. */
  const failingAt = (verb: string): CommandRunner => ({
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return args.includes(verb)
        ? { code: 1, stdout: '', stderr: `${verb} failed` }
        : { code: 0, stdout: answer(args), stderr: '' };
    },
  });

  it('returns to the previous version when the new one fails to come up', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_VERSION: '2.0.0' });

    await expect(updateDeployment({ paths: p, runner: failingAt('--wait'), version: '2.0.1' }))
      .rejects.toThrow(UpdateRolledBack);

    // `up` recreates before it waits for health, so a version that starts and
    // fails its healthcheck has already replaced the one that worked.
    expect(pinnedVersion(p)).toBe('2.0.0');
    const ups = calls.filter((c) => c.args.includes('up'));
    expect(ups.length).toBeGreaterThanOrEqual(2);
  });

  it('names the version it returned to, so an operator need not reconstruct it', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_VERSION: '2.0.0' });
    try {
      await updateDeployment({ paths: p, runner: failingAt('--wait'), version: '2.0.1' });
      throw new Error('expected a rollback');
    } catch (err) {
      expect(err).toBeInstanceOf(UpdateRolledBack);
      expect((err as UpdateRolledBack).previous).toBe('2.0.0');
      expect((err as Error).message).toContain('2.0.0');
    }
  });

  it('does not roll back when the operator asked it not to', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_VERSION: '2.0.0' });

    await expect(updateDeployment({ paths: p, runner: failingAt('--wait'), version: '2.0.1', noRollback: true }))
      .rejects.not.toBeInstanceOf(UpdateRolledBack);
    expect(calls.filter((c) => c.args.includes('up'))).toHaveLength(1);
  });

  it('leaves an unpinned bundle unpinned rather than inventing a version', async () => {
    const p = paths();
    materializeBundle(p, { MYCO_PORT: '8787' });

    await expect(updateDeployment({ paths: p, runner: failingAt('--wait'), version: '2.0.1' }))
      .rejects.toThrow(UpdateRolledBack);

    expect(pinnedVersion(p)).toBeNull();
    expect(readFileSync(p.envFile, 'utf8')).toContain('MYCO_PORT=8787');
  });
});

/**
 * The wait a Compose update performs before it recreates.
 *
 * The harness shares the server's network namespace, so recreating the server
 * stops the harness with it. The runs in flight are waited out first, and the
 * harness's stop grace carries whatever the wait gave up on.
 */
describe('the update waits for what is running', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'run_a', task: 'digest-only', status: 'running', started_at: 0, run_context: JSON.stringify({ timeoutSeconds: 1800 }), ...over,
  });
  /** Answers the live-runs read from a queue, one entry per read, and succeeds at everything else. */
  const scripted = (answers: string[]): CommandRunner => ({
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (!args.includes('--live-runs')) return { code: 0, stdout: '', stderr: '' };
      const next = answers.shift() ?? '[]';
      return next.startsWith('!')
        ? { code: 1, stdout: '', stderr: next.slice(1) }
        : { code: 0, stdout: next, stderr: '' };
    },
  });
  const reads = () => calls.filter((c) => c.args.includes('--live-runs')).length;

  it('names each task in flight, polls until none is left, and only then pulls', async () => {
    const p = paths();
    materializeBundle(p);
    const lines: string[] = [];
    const drive = clock();
    await updateDeployment({
      paths: p, runner: scripted([JSON.stringify([row()]), JSON.stringify([row()]), '[]']),
      report: (l) => lines.push(l), clock: drive,
    });

    expect(lines).toContain('Waiting for a running task: digest-only, started 0 sec ago, budget 30 min');
    expect(lines).toContain('Nothing is running; the deploy proceeds.');
    expect(drive.at).toBe(LIVE_RUN_POLL_MS * 2);
    expect(reads()).toBe(3);
    const flat = calls.map((c) => c.args.join(' '));
    expect(flat.findIndex((a) => a.includes('--live-runs'))).toBeLessThan(flat.findIndex((a) => a.includes('pull')));
  });

  it('asks the running container itself, past the entrypoint and without a TTY', async () => {
    const p = paths();
    materializeBundle(p);
    await updateDeployment({ paths: p, runner: scripted(['[]']), report: () => undefined, clock: clock() });

    const read = calls.find((c) => c.args.includes('--live-runs'))!.args;
    // Naming the binary runs it beside the serving process; the entrypoint
    // would migrate the volume a second time on the way in.
    expect(read.slice(-5)).toEqual(['server', 'bun', 'run', '/app/server.js', '--live-runs']);
    expect(read).toContain('--no-TTY');
    expect(read.slice(0, 5)).toEqual(['compose', '--file', p.composeFile, '--project-name', COMPOSE_PROJECT]);
  });

  it('asks again after a pause when the first answer carries no document, and ships on the second', async () => {
    const p = paths();
    materializeBundle(p);
    const drive = clock();
    await updateDeployment({
      paths: p, runner: scripted(['bun: command not found', '[]']), report: () => undefined, clock: drive,
    });

    expect(reads()).toBe(2);
    expect(drive.at).toBe(LIVE_RUNS_RETRY_MS);
    expect(argvText()).toContain('pull');
  });

  it('GATE: a second bad answer refuses the deploy and recreates nothing, naming what the command said', async () => {
    const p = paths();
    materializeBundle(p);
    // "Nothing came back" and "nothing is running" are opposite facts.
    await expect(updateDeployment({
      paths: p, runner: scripted(['!Error: No such service: server', '!Error: No such service: server']),
      report: () => undefined, clock: clock(),
    })).rejects.toThrow(LiveRunsUnreadable);

    expect(argvText()).not.toContain('pull');
    expect(argvText()).not.toContain('--force-recreate');
  });

  it('--no-drain asks the container nothing at all', async () => {
    const p = paths();
    materializeBundle(p);
    await updateDeployment({ paths: p, runner: scripted(['!Error: No such service: server']), noDrain: true, report: () => undefined });

    // The escape hatch is used when the container cannot be reached, so it must
    // not need the container to work.
    expect(reads()).toBe(0);
    expect(argvText()).toContain('pull');
  });

  it('names the harness grace, not a platform, for a run it stopped waiting on', async () => {
    const p = paths();
    materializeBundle(p);
    const lines: string[] = [];
    const overdue = row({ id: 'run_o', task: 'cortex-instructions', started_at: -200_000, run_context: JSON.stringify({ timeoutSeconds: 100 }) });
    const fresh = row({ id: 'run_f', task: 'titling', started_at: 0, run_context: JSON.stringify({ timeoutSeconds: 300 }) });
    await updateDeployment({
      paths: p,
      runner: scripted([JSON.stringify([overdue]), JSON.stringify([overdue, fresh]), JSON.stringify([overdue, fresh])]),
      report: (l) => lines.push(l), clock: clock(),
    });

    expect(lines).toContain('A task outlived its own budget (cortex-instructions); the deploy proceeds and the stale sweep owns the run.');
    expect(lines).toContain('titling started during the deploy; the harness finishes them inside its stop grace.');
  });

  it('reads the same rows the hosted target reads', async () => {
    // Two query texts across a package boundary the server cannot be imported
    // across; a column added to one and not the other reads a different fleet.
    expect(SERVER_LIVE_RUNS_QUERY).toBe(LIVE_RUNS_QUERY);
  });
});
