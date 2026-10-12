import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '@myco/cli/daemon-guard.js';
import { versionDir } from '@myco/install/managed-binary.js';
import { getPluginVersion } from '@myco/version.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { legacyFixtureHome } from '../setup/fixtures/legacy-home.ts';

let root: string;
let restore: () => void;
let cwd: string;
let lines: string[];
let log: ReturnType<typeof spyOn>;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-daemon-guard-'));
  restore = bindSandboxChildHome(root);
  cwd = process.cwd(); process.chdir(root);
  lines = [];
  log = spyOn(console, 'error').mockImplementation(message => { lines.push(String(message)); });
});
afterEach(() => { log.mockRestore(); process.chdir(cwd); restore(); fs.rmSync(root, { recursive: true, force: true }); });

it('a member home exits normally without marking an adoption failed', () => {
  const home = process.env.MYCO_HOME!;
  fs.mkdirSync(path.join(home, 'member'), { recursive: true });
  fs.writeFileSync(path.join(home, 'member', 'cutover.json'), '{}');
  const slot = versionDir(home, process.platform, getPluginVersion());
  fs.mkdirSync(slot, { recursive: true });
  main();
  expect(lines.join('\n')).toContain('member home');
  expect(fs.existsSync(path.join(slot, '.adopt-failed'))).toBe(false);
});

it('an unmoved 1.4 home refuses and marks its staged version, preserving the vault', () => {
  const fixture = legacyFixtureHome(root);
  process.env.MYCO_HOME = fixture.mycoHome;
  const before = fs.readFileSync(fixture.vault);
  const slot = versionDir(fixture.mycoHome, process.platform, getPluginVersion());
  fs.mkdirSync(slot, { recursive: true });
  main();
  expect(lines.join('\n')).toContain('myco cutover --dry-run');
  expect(fs.readFileSync(path.join(slot, '.adopt-failed'), 'utf8')).toMatch(/^\d{4}-/);
  expect(fs.readFileSync(fixture.vault)).toEqual(before);
});

it('an empty home exits normally saying 2.0 has no daemon and creates no state', () => {
  const home = process.env.MYCO_HOME!;
  expect(fs.existsSync(home)).toBe(false);
  main();
  expect(lines.join('\n')).toContain('Myco 2.0 has no local daemon');
  expect(fs.existsSync(home)).toBe(false);
});

it('marks the staged slot under redirected Windows LOCALAPPDATA', () => {
  const fixture = legacyFixtureHome(root);
  process.env.MYCO_HOME = fixture.mycoHome;
  const previous = process.env.LOCALAPPDATA;
  const localAppData = path.join(root, 'redirected-app-data');
  process.env.LOCALAPPDATA = localAppData;
  try {
    const slot = versionDir(fixture.mycoHome, 'win32', getPluginVersion(), localAppData);
    fs.mkdirSync(slot, { recursive: true });
    main('win32');
    expect(fs.existsSync(path.join(slot, '.adopt-failed'))).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
  }
});
