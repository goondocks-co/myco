import { afterAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { legacyFixtureHome } from '../setup/fixtures/legacy-home.ts';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-retired-verbs-'));
const legacy = legacyFixtureHome(root);
const cwd = legacy.projects[0].root;
execFileSync('git', ['init', '-q', cwd]);
const env = sandboxChildEnv(root, { HOME: legacy.home, MYCO_HOME: path.join(root, 'member-home') });
const fixture = path.resolve(import.meta.dir, '../fixtures/no-legacy-spawn.ts');
const cli = path.resolve(import.meta.dir, '../../packages/myco/src/cli.ts');
const before = fs.readFileSync(legacy.vault);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const verb of [
  'grove', 'subsystem', 'service', 'restart', 'join', 'leave', 'attach', 'detach', 'host',
  'config', 'verify', 'stats', 'search', 'vectors', 'session', 'logs', 'doctor',
  'setup-llm', 'setup-digest', 'detect-providers', 'agent', 'task', '__restore-backup', '__finish-uninstall', 'init',
]) it(`${verb} refuses an unmoved home without starting any process`, () => {
  const result = spawnSync(process.execPath, [fixture, verb], { cwd, env, encoding: 'utf8', timeout: 15_000 });
  expect(result.stderr).not.toContain('FORBIDDEN_PROCESS_SPAWN');
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/myco setup --cutover.*myco login <address>.*myco cutover --dry-run.*myco cutover/s);
  expect(fs.readFileSync(legacy.vault)).toEqual(before);
});

it('help prints member usage and migration guidance on an unmoved home', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { cwd, env, encoding: 'utf8', timeout: 15_000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Project intelligence (answered by the Deployment for this project)');
  expect(result.stdout).toContain('To move your Myco 1.4 data to Myco 2.0, run `myco setup --cutover`. It guides sign-in, previews the move and sets up your agents.');
  expect(result.stdout).toContain('myco cutover --dry-run');
  expect(result.stdout).not.toContain('grove <subcommand>');
});


for (const kind of ['fresh', 'member']) it(`retired verbs on a ${kind} home give current help and successors`, () => {
  const user = path.join(root, kind, 'user');
  const home = path.join(user, '.myco');
  fs.mkdirSync(path.join(home, 'member'), { recursive: true });
  if (kind === 'member') fs.writeFileSync(path.join(home, 'member', 'cutover.json'), JSON.stringify({ backups: {} }), { mode: 0o600 });
  const environment = sandboxChildEnv(root, { HOME: user, MYCO_HOME: home });
  for (const verb of ['restart', 'verify', 'join', 'leave']) {
    const result = spawnSync(process.execPath, [fixture, verb], { cwd, env: environment, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('myco --help');
    expect(result.stderr).not.toContain('myco cutover');
    expect(result.stderr).not.toContain('myco login');
    if (verb === 'verify') expect(result.stderr).toContain('myco doctor');
    if (verb === 'join' || verb === 'leave') expect(result.stderr).toContain(`myco member ${verb}`);
  }
});
