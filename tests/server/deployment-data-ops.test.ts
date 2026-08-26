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
  COMPOSE_PROJECT,
} from '@myco/server/deployment.js';
import type { CommandRunner } from '@myco/server/runner.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), 'myco-dataops-')); roots.push(d); return d; };

let calls: { command: string; args: string[] }[] = [];
const runner = (): CommandRunner => ({
  async run(command, args) { calls.push({ command, args: [...args] }); return { code: 0, stdout: '', stderr: '' }; },
});
beforeEach(() => { calls = []; });

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

    const verbs = calls.map((c) => c.args.find((a) => ['stop', 'cp', 'run', 'up'].includes(a)));
    expect(verbs[0]).toBe('stop');
    expect(verbs.at(-1)).toBe('up');
  });

  it('GATE: clears the WAL sidecar, which describes the replaced database', async () => {
    const p = paths();
    await restoreDeployment({ paths: p, runner: runner(), source: backupDir() });
    // Left in place it is replayed over the snapshot, undoing the restore.
    expect(argvText()).toContain('rm -f /data/myco.sqlite-wal /data/myco.sqlite-shm');
  });
});

describe('update', () => {
  it('pulls then recreates, and does not migrate itself', async () => {
    const p = paths();
    materializeBundle(p);
    await updateDeployment({ paths: p, runner: runner() });

    expect(calls[0]!.args).toContain('pull');
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['up', '--detach', '--wait']));
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
          : { code: 0, stdout: '', stderr: '' };
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
