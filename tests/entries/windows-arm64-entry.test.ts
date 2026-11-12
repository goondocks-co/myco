/**
 * The windows-arm64 binary's entry, run as the binary runs it: it carries no native SQLite artifacts, so member verbs
 * run as on every target and every verb that would host a Deployment on this machine refuses before it writes anything,
 * naming what to do instead.
 */
import { afterAll, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const ENTRY = path.resolve(import.meta.dir, '../../packages/myco/src/entries/cli.windows-arm64.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-windows-arm64-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Runs the entry in a fresh home; returns what it printed and every file it left under that home. */
function run(args: string[]): { status: number | null; out: string; written: string[] } {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  // Bun's transpiler cache would otherwise write under the home.
  const env = sandboxChildEnv(root, { HOME: home, MYCO_HOME: path.join(home, '.myco'), NO_COLOR: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' });
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd: home, encoding: 'utf8', timeout: 60_000, input: '', env });
  const written = fs.readdirSync(home, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  return { status: result.status, out: `${result.stdout}${result.stderr}`, written };
}

it('reports its version and runs a member verb', () => {
  expect(run(['--version'])).toMatchObject({ status: 0, out: expect.stringMatching(/^\d+\.\d+\.\d+/) });
  expect(run(['doctor'])).toMatchObject({ status: 0, out: expect.stringContaining('myco doctor (member)') });
});

for (const args of [['server', 'create', '--target', 'local'], ['server', 'install', '--target', 'local'], ['server', 'status'],
  ['server', 'setup-owner', '--target', 'local'], ['server', 'backup', '--target', 'local', '--to', 'backup'],
  ['setup', '--create', 'local', '--yes', '--serve', 'service']]) {
  it(`refuses \`myco ${args.join(' ')}\` with what to use instead, and writes nothing`, () => {
    const refused = run(args);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toMatch(/Myco for Windows ARM64 does not carry the SQLite libraries.*Nothing was changed\..*myco setup --create cloudflare.*`myco setup --join <address>`/s);
    expect(refused.written).toEqual([]);
  });
}
