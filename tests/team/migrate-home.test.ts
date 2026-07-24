import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { vi } from '../helpers/vi-shim.js';
import { migrateTeamsHomeIfNeeded, defaultLegacyTeamHomes } from '@myco/team/migrate-home.js';
import { secretStoreLockKeys } from '@myco/config/secret-store-lock.js';

const TEAM_ID = 'team_' + 'c'.repeat(32);
const SECRETS_WRITER_HELPER = path.resolve('tests/helpers/secrets-writer-helper.ts');
const SECRETS_LOCK_HOLDER_HELPER = path.resolve('tests/helpers/secrets-lock-holder-helper.ts');
const SECRETS_PROPAGATE_HELPER = path.resolve('tests/helpers/secrets-propagate-helper.ts');
const MIGRATION_CRASH_HELPER = path.resolve('tests/team/migrate-home-crash-helper.ts');

function secretStoreKeys(vaultDir: string): string[] {
  return secretStoreLockKeys(vaultDir);
}

async function waitForPath(target: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(target)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function successfulExit(child: ReturnType<typeof spawn>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${stderr}`)));
    child.on('error', reject);
  });
}

function writeTeam(home: string, teamId: string, json: Record<string, unknown>, secret = 'MYCO_TEAM_API_KEY=abc\n') {
  const dir = path.join(home, 'teams', teamId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'team.json'), JSON.stringify(json), 'utf-8');
  fs.writeFileSync(path.join(dir, 'secrets.env'), secret, { mode: 0o600 });
}

describe('migrateTeamsHomeIfNeeded', () => {
  let legacy: string; let dest: string;
  const prevTeamHome = process.env.MYCO_TEAM_HOME;
  afterEach(() => {
    vi.restoreAllMocks();
    if (prevTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeamHome;
    fs.rmSync(legacy, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  it('copies + verifies legacy teams, then retires the source dir; idempotent', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });

    const res = migrateTeamsHomeIfNeeded([legacy]);

    expect(res.copied).toContain(TEAM_ID);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID, 'team.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env'), 'utf-8')).toContain('MYCO_TEAM_API_KEY=abc');
    expect(fs.lstatSync(path.join(legacy, 'teams')).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(legacy, 'teams'))).toBe(fs.realpathSync(path.join(dest, 'teams')));
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'team.json'))).toBe(true);
    expect(migrateTeamsHomeIfNeeded([legacy]).copied.length).toBe(0);
  });

  it('copies a non-flat team dir: the worker/ deploy subtree is migrated, not dropped', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    // Real team dirs are NOT flat — they hold a `worker/` deploy subdir (wrangler
    // source + node_modules + cached account binding). The migration must copy it.
    const worker = path.join(legacy, 'teams', TEAM_ID, 'worker');
    fs.mkdirSync(path.join(worker, 'src'), { recursive: true });
    fs.mkdirSync(path.join(worker, 'node_modules', '.cache'), { recursive: true });
    fs.writeFileSync(path.join(worker, 'wrangler.toml'), 'name="t"\n');
    fs.writeFileSync(path.join(worker, 'src', 'index.ts'), 'export default {}\n');
    fs.writeFileSync(path.join(worker, 'node_modules', '.cache', 'acct.json'), '{"id":"x"}');

    const res = migrateTeamsHomeIfNeeded([legacy]);

    expect(res.copied).toContain(TEAM_ID);
    const dstWorker = path.join(dest, 'teams', TEAM_ID, 'worker');
    expect(fs.readFileSync(path.join(dstWorker, 'wrangler.toml'), 'utf-8')).toBe('name="t"\n');
    expect(fs.readFileSync(path.join(dstWorker, 'src', 'index.ts'), 'utf-8')).toBe('export default {}\n');
    expect(fs.readFileSync(path.join(dstWorker, 'node_modules', '.cache', 'acct.json'), 'utf-8')).toBe('{"id":"x"}');
    // verify-before-retire passed (subtree present at dst) so the source was retired with its worker/
    expect(fs.lstatSync(path.join(legacy, 'teams')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'worker', 'src', 'index.ts'))).toBe(true);
  });

  it('keeps an existing worker subtree destination-owned while retaining the complete legacy subtree', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const config = { team_id: TEAM_ID, name: 'L', projects: [] };
    writeTeam(legacy, TEAM_ID, config);
    writeTeam(dest, TEAM_ID, config);
    const legacyWorker = path.join(legacy, 'teams', TEAM_ID, 'worker');
    const destinationWorker = path.join(dest, 'teams', TEAM_ID, 'worker');
    fs.mkdirSync(path.join(legacyWorker, 'src'), { recursive: true });
    fs.mkdirSync(path.join(destinationWorker, 'src'), { recursive: true });
    fs.writeFileSync(path.join(legacyWorker, 'src', 'legacy-only.ts'), 'legacy\n');
    fs.writeFileSync(path.join(legacyWorker, 'src', 'common.ts'), 'legacy common\n');
    fs.writeFileSync(path.join(destinationWorker, 'src', 'canonical-only.ts'), 'canonical\n');
    fs.writeFileSync(path.join(destinationWorker, 'src', 'common.ts'), 'canonical common\n');

    migrateTeamsHomeIfNeeded([legacy]);

    expect(fs.existsSync(path.join(destinationWorker, 'src', 'legacy-only.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(destinationWorker, 'src', 'common.ts'), 'utf-8')).toBe('canonical common\n');
    const retainedWorker = path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'worker', 'src');
    expect(fs.readFileSync(path.join(retainedWorker, 'legacy-only.ts'), 'utf-8')).toBe('legacy\n');
    expect(fs.readFileSync(path.join(retainedWorker, 'common.ts'), 'utf-8')).toBe('legacy common\n');
    expect(fs.lstatSync(path.join(legacy, 'teams')).isSymbolicLink()).toBe(true);
  });

  it('gap-fills: copies missing files into a pre-existing dest team dir', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;

    // Pre-create the dest with only team.json (no secrets.env); content matches legacy so no conflict
    const destTeamDir = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeamDir, { recursive: true });
    const sharedJson = JSON.stringify({ team_id: TEAM_ID, name: 'L', projects: [] });
    fs.writeFileSync(path.join(destTeamDir, 'team.json'), sharedJson, 'utf-8');

    // Legacy has both team.json (same content as dest) and secrets.env (gap)
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });

    const res = migrateTeamsHomeIfNeeded([legacy]);

    expect(res.gapFilled).toContain(TEAM_ID);
    const df = path.join(destTeamDir, 'secrets.env');
    expect(fs.existsSync(df)).toBe(true);
    expect(fs.readFileSync(df, 'utf-8')).toContain('MYCO_TEAM_API_KEY=abc');
    expect((fs.statSync(df).mode & 0o777) === 0o600).toBe(true);
  });

  it('preserves validated CRLF secret bytes without creating a spurious conflict backup', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const bytes = Buffer.from('# café ☕\r\nKEY=legacy-🔐\r\n', 'utf-8');
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] }, bytes.toString('utf-8'));

    migrateTeamsHomeIfNeeded([legacy]);
    const destinationSecret = path.join(dest, 'teams', TEAM_ID, 'secrets.env');
    expect(fs.readFileSync(destinationSecret)).toEqual(bytes);
    expect(fs.existsSync(destinationSecret + '.bak-pre-myco-team')).toBe(false);
  });

  it('rejects a malformed legacy secret before creating the destination team tree', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] }, 'GOOD=secret\nBROKEN\rVALUE\n');

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID, 'secrets.env'))).toBe(true);
  });

  it('preflights every legacy team before copying a valid earlier team', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const validTeam = 'team_' + 'a'.repeat(32);
    const malformedTeam = 'team_' + 'b'.repeat(32);
    writeTeam(legacy, validTeam, { team_id: validTeam, name: 'valid', projects: [] });
    writeTeam(legacy, malformedTeam, { team_id: malformedTeam, name: 'bad', projects: [] }, 'BROKEN\rVALUE\n');

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
    expect(fs.existsSync(path.join(dest, 'teams', validTeam))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'teams', malformedTeam))).toBe(false);
  });

  it('tightens validated legacy secrets before retiring the source tree', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const sourceSecret = path.join(legacy, 'teams', TEAM_ID, 'secrets.env');
    fs.chmodSync(sourceSecret, 0o644);

    migrateTeamsHomeIfNeeded([legacy]);
    const retiredSecret = path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'secrets.env');
    expect(fs.statSync(retiredSecret).mode & 0o777).toBe(0o600);
  });

  it('writes migrated and conflicting secret files atomically with owner-only permissions', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] }, 'KEY=legacy\r\n');

    const destTeamDir = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeamDir, { recursive: true });
    fs.writeFileSync(path.join(destTeamDir, 'team.json'), JSON.stringify({ team_id: TEAM_ID, name: 'L', projects: [] }));
    fs.writeFileSync(path.join(destTeamDir, 'secrets.env'), 'KEY=destination\n', { mode: 0o644 });

    const result = migrateTeamsHomeIfNeeded([legacy]);
    const destinationSecret = path.join(destTeamDir, 'secrets.env');
    const backupSecret = destinationSecret + '.bak-pre-myco-team';

    expect(result.conflicted).toContain(TEAM_ID);
    expect(fs.readFileSync(destinationSecret, 'utf-8')).toBe('KEY=destination\n');
    expect(fs.readFileSync(backupSecret, 'utf-8')).toBe('KEY=legacy\r\n');
    expect(fs.statSync(destinationSecret).mode & 0o777).toBe(0o600);
    expect(fs.statSync(backupSecret).mode & 0o777).toBe(0o600);
  });

  it('never overwrites an earlier divergent secret backup from another legacy home', () => {
    const legacyA = fs.mkdtempSync(path.join(os.tmpdir(), 'legacyA-'));
    const legacyB = fs.mkdtempSync(path.join(os.tmpdir(), 'legacyB-'));
    legacy = legacyA;
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(dest, TEAM_ID, { team_id: TEAM_ID, name: 'DEST', projects: [] }, 'KEY=destination\n');
    writeTeam(legacyA, TEAM_ID, { team_id: TEAM_ID, name: 'A', projects: [] }, 'KEY=legacy-a\n');
    writeTeam(legacyB, TEAM_ID, { team_id: TEAM_ID, name: 'B', projects: [] }, 'KEY=legacy-b\n');

    try {
      expect(() => migrateTeamsHomeIfNeeded([legacyA, legacyB])).toThrow();
      expect(fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env'), 'utf-8')).toBe('KEY=destination\n');
      expect(fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env.bak-pre-myco-team'), 'utf-8'))
        .toBe('KEY=legacy-a\n');
      expect(fs.readFileSync(path.join(legacyB, 'teams', TEAM_ID, 'secrets.env'), 'utf-8')).toBe('KEY=legacy-b\n');
      expect(fs.existsSync(path.join(legacyA, 'teams.bak-pre-myco-team', TEAM_ID, 'secrets.env'))).toBe(true);
    } finally {
      fs.rmSync(legacyB, { recursive: true, force: true });
    }
  });

  it('leaves the source unretired when strict permission enforcement fails', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const sourceSecret = path.join(legacy, 'teams', TEAM_ID, 'secrets.env');
    fs.chmodSync(sourceSecret, 0o644);
    const realChmod = fs.chmodSync.bind(fs);
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation((pathname, mode) => {
      if (path.resolve(String(pathname)) === path.resolve(sourceSecret)) {
        throw Object.assign(new Error('injected chmod failure'), { code: 'EPERM' });
      }
      return realChmod(pathname, mode);
    });

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow('injected chmod failure');
    chmod.mockRestore();
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID, 'secrets.env'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID))).toBe(false);
  });

  it.each(['destination', 'backup'])('refuses a %s secret symlink without touching its sibling target', (kind) => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] }, 'KEY=legacy\n');
    const destTeam = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeam, { recursive: true });
    fs.writeFileSync(path.join(destTeam, 'team.json'), JSON.stringify({ team_id: TEAM_ID, name: 'L', projects: [] }));
    if (kind === 'backup') fs.writeFileSync(path.join(destTeam, 'secrets.env'), 'KEY=destination\n', { mode: 0o600 });
    const sibling = path.join(dest, `${kind}-sibling.env`);
    fs.writeFileSync(sibling, 'SIBLING=untouched\n', { mode: 0o644 });
    const link = path.join(destTeam, kind === 'destination' ? 'secrets.env' : 'secrets.env.bak-pre-myco-team');
    fs.symlinkSync(sibling, link);
    const before = fs.readFileSync(sibling);
    const beforeMode = fs.statSync(sibling).mode & 0o777;

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
    expect(fs.readFileSync(sibling)).toEqual(before);
    expect(fs.statSync(sibling).mode & 0o777).toBe(beforeMode);
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID))).toBe(true);
  });

  it('refuses a secretless destination Team-directory symlink without touching its target', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    fs.rmSync(path.join(legacy, 'teams', TEAM_ID, 'secrets.env'));
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'team-symlink-target-'));
    fs.writeFileSync(path.join(sibling, 'sentinel.txt'), 'untouched\n');
    fs.mkdirSync(path.join(dest, 'teams'), { recursive: true });
    fs.symlinkSync(sibling, path.join(dest, 'teams', TEAM_ID), 'dir');

    try {
      expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow(/not a real directory/);
      expect(fs.readdirSync(sibling)).toEqual(['sentinel.txt']);
      expect(fs.readFileSync(path.join(sibling, 'sentinel.txt'), 'utf-8')).toBe('untouched\n');
      expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID, 'team.json'))).toBe(true);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('leaves a durable redirect so concurrent legacy and canonical writers share one store', async () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });

    migrateTeamsHomeIfNeeded([legacy]);
    const legacyTeams = path.join(legacy, 'teams');
    expect(fs.lstatSync(legacyTeams).isSymbolicLink()).toBe(true);

    const children = [
      spawn(process.execPath, ['run', SECRETS_WRITER_HELPER, path.join(legacyTeams, TEAM_ID), 'LEGACY_WRITER', 'redirected'], {
        stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd(),
      }),
      spawn(process.execPath, ['run', SECRETS_WRITER_HELPER, path.join(dest, 'teams', TEAM_ID), 'CANONICAL_WRITER', 'canonical'], {
        stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd(),
      }),
    ];
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
      child.on('error', reject);
    })));

    const canonical = fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env'), 'utf-8');
    expect(canonical).toContain('LEGACY_WRITER=redirected');
    expect(canonical).toContain('CANONICAL_WRITER=canonical');
    expect(fs.realpathSync(legacyTeams)).toBe(fs.realpathSync(path.join(dest, 'teams')));
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'secrets.env'))).toBe(true);
    expect(migrateTeamsHomeIfNeeded([legacy]).retiredHomes).toEqual([]);
  }, 30_000);

  it('upgrades an archive-only legacy topology by recovering the durable redirect', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const config = { team_id: TEAM_ID, name: 'L', projects: [] };
    writeTeam(legacy, TEAM_ID, config);
    writeTeam(dest, TEAM_ID, config);
    fs.rmSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env'));
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';
    fs.renameSync(legacyTeams, archive);

    const result = migrateTeamsHomeIfNeeded([legacy]);

    expect(result.retiredHomes).toEqual([legacyTeams]);
    expect(fs.lstatSync(legacyTeams).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyTeams)).toBe(fs.realpathSync(path.join(dest, 'teams')));
    expect(fs.existsSync(path.join(archive, TEAM_ID, 'team.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'secrets.env'), 'utf-8'))
      .toBe('MYCO_TEAM_API_KEY=abc\n');
    expect(migrateTeamsHomeIfNeeded([legacy]).retiredHomes).toEqual([]);
  });

  it('resumes after process termination between archive and redirect publication', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';

    const crashed = spawnSync(
      process.execPath,
      ['run', MIGRATION_CRASH_HELPER, legacy, dest],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    expect(crashed.status).toBe(86);
    expect(fs.existsSync(legacyTeams)).toBe(false);
    expect(fs.existsSync(path.join(archive, TEAM_ID, 'team.json'))).toBe(true);

    const result = migrateTeamsHomeIfNeeded([legacy]);

    expect(result.retiredHomes).toEqual([legacyTeams]);
    expect(fs.lstatSync(legacyTeams).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(legacyTeams)).toBe(fs.realpathSync(path.join(dest, 'teams')));
    expect(fs.existsSync(path.join(archive, TEAM_ID, 'team.json'))).toBe(true);
    expect(fs.readdirSync(legacy).filter((name) => name.startsWith('teams.redirect-'))).toEqual([]);
  });

  it('refuses a source recreated during recovery before copying archive data', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'archived', projects: [] });
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';
    fs.renameSync(legacyTeams, archive);
    const readdirSync = fs.readdirSync.bind(fs);
    let recreated = false;
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(((target, options) => {
      if (!recreated && path.resolve(String(target)) === path.resolve(archive)) {
        recreated = true;
        writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'recreated', projects: [] });
      }
      return readdirSync(target, options);
    }) as typeof fs.readdirSync);

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
    readdir.mockRestore();

    expect(recreated).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(legacyTeams, TEAM_ID, 'team.json'), 'utf-8')).name)
      .toBe('recreated');
    expect(JSON.parse(fs.readFileSync(path.join(archive, TEAM_ID, 'team.json'), 'utf-8')).name)
      .toBe('archived');
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID, 'team.json'))).toBe(false);
  });

  it('preserves a canonical record written through the claimed redirect during recovery', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'archived', projects: [] });
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';
    fs.renameSync(legacyTeams, archive);
    const destinationRecord = path.join(dest, 'teams', TEAM_ID, 'team.json');
    const copyFileSync = fs.copyFileSync.bind(fs);
    let wroteConcurrentRecord = false;
    const copyFile = vi.spyOn(fs, 'copyFileSync').mockImplementation(((source, destination, mode) => {
      if (!wroteConcurrentRecord
        && path.resolve(String(destination)) === path.resolve(destinationRecord)) {
        wroteConcurrentRecord = true;
        fs.writeFileSync(
          path.join(legacyTeams, TEAM_ID, 'team.json'),
          JSON.stringify({ team_id: TEAM_ID, name: 'concurrent-writer', projects: [] }),
        );
      }
      copyFileSync(source, destination, mode);
    }) as typeof fs.copyFileSync);

    migrateTeamsHomeIfNeeded([legacy]);
    copyFile.mockRestore();

    expect(wroteConcurrentRecord).toBe(true);
    expect(JSON.parse(fs.readFileSync(destinationRecord, 'utf-8')).name).toBe('concurrent-writer');
    expect(JSON.parse(fs.readFileSync(`${destinationRecord}.bak-pre-myco-team`, 'utf-8')).name)
      .toBe('archived');
  });

  it('preserves a canonical subtree file written through the claimed redirect during recovery', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'archived', projects: [] });
    const legacyWorker = path.join(legacy, 'teams', TEAM_ID, 'worker');
    fs.mkdirSync(path.join(legacyWorker, 'src'), { recursive: true });
    fs.writeFileSync(path.join(legacyWorker, 'src', 'index.ts'), 'archive\n');
    fs.writeFileSync(path.join(legacyWorker, 'src', 'archive-only.ts'), 'archive-only\n');
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';
    fs.renameSync(legacyTeams, archive);
    const destinationWorker = path.join(dest, 'teams', TEAM_ID, 'worker');
    const cpSync = fs.cpSync.bind(fs);
    let wroteConcurrentFile = false;
    const cp = vi.spyOn(fs, 'cpSync').mockImplementation(((source, destination, options) => {
      if (!wroteConcurrentFile
        && path.resolve(String(destination)) === path.resolve(destinationWorker)) {
        wroteConcurrentFile = true;
        const writerSource = path.join(legacyTeams, TEAM_ID, 'worker', 'src');
        fs.mkdirSync(writerSource, { recursive: true });
        fs.writeFileSync(path.join(writerSource, 'index.ts'), 'concurrent-writer\n');
      }
      cpSync(source, destination, options);
    }) as typeof fs.cpSync);

    migrateTeamsHomeIfNeeded([legacy]);
    cp.mockRestore();

    expect(wroteConcurrentFile).toBe(true);
    expect(fs.readFileSync(path.join(destinationWorker, 'src', 'index.ts'), 'utf-8'))
      .toBe('concurrent-writer\n');
    expect(fs.readFileSync(path.join(destinationWorker, 'src', 'archive-only.ts'), 'utf-8'))
      .toBe('archive-only\n');
    expect(fs.readFileSync(path.join(archive, TEAM_ID, 'worker', 'src', 'index.ts'), 'utf-8'))
      .toBe('archive\n');
  });

  it('retains a recovery marker when redirect verification fails after publication', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'archived', projects: [] });
    const legacyTeams = path.join(legacy, 'teams');
    const archive = legacyTeams + '.bak-pre-myco-team';
    fs.renameSync(legacyTeams, archive);
    const lstatSync = fs.lstatSync.bind(fs);
    let legacyStats = 0;
    const lstat = vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (path.resolve(String(target)) === path.resolve(legacyTeams)) {
        legacyStats += 1;
        if (legacyStats === 2) {
          throw Object.assign(new Error('injected redirect verification failure'), { code: 'EIO' });
        }
      }
      return lstatSync(target, options);
    }) as typeof fs.lstatSync);

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow('injected redirect verification failure');
    lstat.mockRestore();
    expect(fs.lstatSync(legacyTeams).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(legacy).some((name) => name.startsWith('teams.redirect-'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID, 'team.json'))).toBe(false);

    const result = migrateTeamsHomeIfNeeded([legacy]);

    expect(result.retiredHomes).toEqual([legacyTeams]);
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'teams', TEAM_ID, 'team.json'), 'utf-8')).name)
      .toBe('archived');
    expect(fs.readdirSync(legacy).filter((name) => name.startsWith('teams.redirect-'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'revalidates a waiter that computed the legacy identity before redirect publication',
    async () => {
      legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
      dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
      process.env.MYCO_TEAM_HOME = dest;
      writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
      const legacyTeamDir = path.join(legacy, 'teams', TEAM_ID);

      let anchor: string;
      do {
        anchor = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-anchor-'));
        if (!secretStoreKeys(anchor).every((anchorKey) => (
          secretStoreKeys(legacyTeamDir).every((legacyKey) => anchorKey < legacyKey)
        ))) {
          fs.rmSync(anchor, { recursive: true, force: true });
          anchor = '';
        }
      } while (!anchor);
      fs.writeFileSync(path.join(anchor, 'secrets.env'), 'WAITER_VALUE=preserved\n', { mode: 0o600 });

      try {
        const holder = spawn(
          process.execPath,
          ['run', SECRETS_LOCK_HOLDER_HELPER, anchor, '2000', 'hold-only'],
          { stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd() },
        );
        const holderExit = successfulExit(holder, 'anchor holder');
        await waitForPath(path.join(anchor, 'secrets-lock-ready'));

        const started = path.join(anchor, 'propagate-started');
        const waiter = spawn(
          process.execPath,
          ['run', SECRETS_PROPAGATE_HELPER, anchor, legacyTeamDir, started],
          { stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd() },
        );
        const waiterExit = successfulExit(waiter, 'stale-identity waiter');
        await waitForPath(started);
        await new Promise((resolve) => setTimeout(resolve, 100));

        migrateTeamsHomeIfNeeded([legacy]);
        const canonicalTeamDir = path.join(dest, 'teams', TEAM_ID);
        const canonicalWriter = spawn(
          process.execPath,
          ['run', SECRETS_WRITER_HELPER, canonicalTeamDir, 'CANONICAL_WRITER', 'canonical'],
          { stdio: ['ignore', 'ignore', 'pipe'], cwd: process.cwd() },
        );
        await successfulExit(canonicalWriter, 'canonical writer');
        await Promise.all([holderExit, waiterExit]);

        const canonical = fs.readFileSync(path.join(canonicalTeamDir, 'secrets.env'), 'utf-8');
        expect(canonical).toContain('MYCO_TEAM_API_KEY=abc');
        expect(canonical).toContain('CANONICAL_WRITER=canonical');
        expect(canonical).toContain('WAITER_VALUE=preserved');
        expect(fs.realpathSync(path.join(legacy, 'teams'))).toBe(fs.realpathSync(path.join(dest, 'teams')));
      } finally {
        fs.rmSync(anchor, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.each(['wrong', 'dangling'])('refuses a %s legacy Team redirect without replacing it', (kind) => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const link = path.join(legacy, 'teams');
    const target = kind === 'wrong'
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'wrong-team-target-'))
      : path.join(legacy, 'missing-team-target');
    fs.symlinkSync(target, link, 'dir');
    try {
      expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(link)).toBe(target);
      expect(fs.existsSync(link + '.bak-pre-myco-team')).toBe(false);
    } finally {
      if (kind === 'wrong') fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('refuses a recreated real source that conflicts with the fixed archive before copying', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    const archiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-archive-'));
    writeTeam(archiveHome, TEAM_ID, { team_id: TEAM_ID, name: 'archived', projects: [] });
    fs.renameSync(path.join(archiveHome, 'teams'), path.join(legacy, 'teams.bak-pre-myco-team'));
    fs.rmSync(archiveHome, { recursive: true, force: true });
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'recreated', projects: [] });

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow(/archive already exists/);
    expect(JSON.parse(fs.readFileSync(
      path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'team.json'),
      'utf-8',
    )).name).toBe('archived');
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID, 'team.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_ID, 'team.json'))).toBe(false);
  });

  it('rolls the source tree back when durable redirect creation fails', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const symlink = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('injected redirect failure'), { code: 'EIO' });
    });

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow('injected redirect failure');
    symlink.mockRestore();
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID, 'team.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team'))).toBe(false);
    expect(fs.readdirSync(legacy).some((name) => name.includes('.redirect-'))).toBe(false);
  });

  it('tightens a pre-existing valid secret backup after all inputs pass preflight', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const destTeam = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeam, { recursive: true });
    fs.writeFileSync(path.join(destTeam, 'team.json'), JSON.stringify({ team_id: TEAM_ID, name: 'L', projects: [] }));
    fs.writeFileSync(path.join(destTeam, 'secrets.env'), 'MYCO_TEAM_API_KEY=abc\n', { mode: 0o600 });
    const backup = path.join(destTeam, 'secrets.env.bak-pre-myco-team');
    fs.writeFileSync(backup, 'MYCO_TEAM_API_KEY=older\n', { mode: 0o644 });

    migrateTeamsHomeIfNeeded([legacy]);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
  });

  it.each(['destination', 'backup'])('leaves every team file unchanged when a malformed %s secret is preflighted', (target) => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'L', projects: [] });
    const destTeam = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeam, { recursive: true });
    fs.writeFileSync(path.join(destTeam, 'team.json'), JSON.stringify({ team_id: TEAM_ID, name: 'L', projects: [] }));
    const targetPath = target === 'destination'
      ? path.join(destTeam, 'secrets.env')
      : path.join(destTeam, 'secrets.env.bak-pre-myco-team');
    fs.writeFileSync(targetPath, 'BROKEN\rVALUE\n', { mode: 0o644 });
    const before = fs.readFileSync(targetPath);
    const beforeMode = fs.statSync(targetPath).mode & 0o777;

    expect(() => migrateTeamsHomeIfNeeded([legacy])).toThrow();
    expect(fs.readFileSync(targetPath)).toEqual(before);
    expect(fs.statSync(targetPath).mode & 0o777).toBe(beforeMode);
    expect(fs.existsSync(path.join(legacy, 'teams', TEAM_ID))).toBe(true);
  });

  it('divergence-archive: archives legacy file when dest content differs; dest unchanged; source retired', () => {
    legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;

    // Pre-create dest with different team.json content
    const destTeamDir = path.join(dest, 'teams', TEAM_ID);
    fs.mkdirSync(destTeamDir, { recursive: true });
    const destContent = JSON.stringify({ team_id: TEAM_ID, name: 'DEST', projects: [] });
    fs.writeFileSync(path.join(destTeamDir, 'team.json'), destContent, 'utf-8');
    fs.writeFileSync(path.join(destTeamDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=dest\n', { mode: 0o600 });

    // Legacy has different content
    writeTeam(legacy, TEAM_ID, { team_id: TEAM_ID, name: 'LEGACY', projects: [] }, 'MYCO_TEAM_API_KEY=legacy\n');

    const res = migrateTeamsHomeIfNeeded([legacy]);

    expect(res.conflicted).toContain(TEAM_ID);
    // Dest content unchanged
    expect(fs.readFileSync(path.join(destTeamDir, 'team.json'), 'utf-8')).toBe(destContent);
    // Legacy archived as .bak
    expect(fs.existsSync(path.join(destTeamDir, 'team.json.bak-pre-myco-team'))).toBe(true);
    // Source dir was still retired (all files accounted for via bak)
    expect(fs.lstatSync(path.join(legacy, 'teams')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team'))).toBe(true);
  });

  it('two homes: migrates from both legacy homes into one dest', () => {
    const legacyA = fs.mkdtempSync(path.join(os.tmpdir(), 'legacyA-'));
    const legacyB = fs.mkdtempSync(path.join(os.tmpdir(), 'legacyB-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    legacy = legacyA; // for afterEach cleanup (legacyB cleaned below)
    process.env.MYCO_TEAM_HOME = dest;

    const TEAM_A = 'team_' + 'a'.repeat(32);
    const TEAM_B = 'team_' + 'b'.repeat(32);
    writeTeam(legacyA, TEAM_A, { team_id: TEAM_A, name: 'A', projects: [] });
    writeTeam(legacyB, TEAM_B, { team_id: TEAM_B, name: 'B', projects: [] });

    const res = migrateTeamsHomeIfNeeded([legacyA, legacyB]);

    expect(res.copied).toContain(TEAM_A);
    expect(res.copied).toContain(TEAM_B);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_A, 'team.json'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'teams', TEAM_B, 'team.json'))).toBe(true);
    expect(fs.lstatSync(path.join(legacyA, 'teams')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(legacyB, 'teams')).isSymbolicLink()).toBe(true);

    // cleanup legacyB (legacy (=legacyA) and dest cleaned in afterEach)
    fs.rmSync(legacyB, { recursive: true, force: true });
  });

  it('non-throwing: returns empty result for non-existent home', () => {
    legacy = path.join(os.tmpdir(), 'no-such-home-' + Date.now());
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'teamhome-'));
    process.env.MYCO_TEAM_HOME = dest;

    let result: ReturnType<typeof migrateTeamsHomeIfNeeded> | undefined;
    expect(() => { result = migrateTeamsHomeIfNeeded(['/no/such/home']); }).not.toThrow();
    expect(result!.copied.length).toBe(0);
    expect(result!.gapFilled.length).toBe(0);
    expect(result!.conflicted.length).toBe(0);
    expect(result!.retiredHomes.length).toBe(0);
  });
});

describe('defaultLegacyTeamHomes env override', () => {
  it('UNSET: returns default homes including .myco and .myco-dev', () => {
    // Pass env: {} so MYCO_HOME does not leak in from the runner
    const homes = defaultLegacyTeamHomes('/fake/home', {});
    expect(homes.some((h) => h === '/fake/home/.myco')).toBe(true);
    expect(homes.some((h) => h === '/fake/home/.myco-dev')).toBe(true);
  });

  it('EMPTY: returns [] when MYCO_TEAM_LEGACY_HOMES is an empty string', () => {
    const homes = defaultLegacyTeamHomes('/fake/home', { MYCO_TEAM_LEGACY_HOMES: '' });
    expect(homes).toEqual([]);
  });

  it('EXPLICIT: returns only the listed paths when MYCO_TEAM_LEGACY_HOMES is set', () => {
    const homes = defaultLegacyTeamHomes('/fake/home', {
      MYCO_TEAM_LEGACY_HOMES: '/a' + path.delimiter + '/b',
    });
    expect(homes).toEqual(['/a', '/b']);
  });
});
