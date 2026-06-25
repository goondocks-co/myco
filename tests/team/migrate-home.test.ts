import { describe, expect, it, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateTeamsHomeIfNeeded, defaultLegacyTeamHomes } from '@myco/team/migrate-home.js';

const TEAM_ID = 'team_' + 'c'.repeat(32);
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
    expect(fs.existsSync(path.join(legacy, 'teams'))).toBe(false);
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
    expect(fs.existsSync(path.join(legacy, 'teams'))).toBe(false);
    expect(fs.existsSync(path.join(legacy, 'teams.bak-pre-myco-team', TEAM_ID, 'worker', 'src', 'index.ts'))).toBe(true);
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
    expect(fs.existsSync(path.join(legacy, 'teams'))).toBe(false);
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
    expect(fs.existsSync(path.join(legacyA, 'teams'))).toBe(false);
    expect(fs.existsSync(path.join(legacyB, 'teams'))).toBe(false);

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
