import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHILD_HOME_NAMES, sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-child-'));
const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-outside-'));
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sibling, { recursive: true, force: true });
});
const probe = path.join(root, 'provision-probe.cjs');
fs.writeFileSync(probe, `const path = require('node:path');
const names = ${JSON.stringify(CHILD_HOME_NAMES)};
for (const name of names) {
  const relative = path.relative(process.env.MYCO_TEST_CHILD_ROOT, process.env[name] || '/');
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) process.exit(70);
}
process.stdout.write(JSON.stringify(Object.fromEntries(names.map(name => [name, process.env[name]]))));
`);

describe('installer and provision child home guard', () => {
  it('passes all configuration homes inside the fixture to the child', () => {
    const env = sandboxChildEnv(root);
    const result = spawnSync(process.execPath, [probe], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout);
    for (const name of CHILD_HOME_NAMES) expect(seen[name]).toBe(env[name]);
  });

  for (const name of CHILD_HOME_NAMES) it(`rejects escaping ${name} before a provision child starts`, async () => {
    const env = { ...sandboxChildEnv(root), [name]: sibling };
    const denied = spawnSync(process.execPath, [probe], { env });
    expect(denied.error?.message).toMatch(/TEST SAFETY: spawned child/);
    expect(denied.pid).toBeUndefined();
    await expect(new Promise((resolve, reject) => {
      try {
        const child = spawn(process.execPath, [probe], { env });
        child.once('error', reject);
        child.once('exit', resolve);
      } catch (error) { reject(error); }
    })).rejects.toThrow(/TEST SAFETY: spawned child/);
    expect(() => execFileSync(process.execPath, [probe], { env })).toThrow(/TEST SAFETY: spawned child/);
    expect(() => Bun.spawnSync([process.execPath, probe], { env })).toThrow(/TEST SAFETY: spawned child/);
    expect(() => Bun.spawn({ cmd: [process.execPath, probe], env })).toThrow(/TEST SAFETY: spawned child/);
  });

  it('rejects a child HOME outside the entire test run without a fixture marker', () => {
    const denied = spawnSync(process.execPath, [probe], { env: { HOME: '/outside-test-run' } });
    expect(denied.error?.message).toMatch(/TEST SAFETY/);
    expect(denied.pid).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('rejects a home symlink escaping its fixture', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(sibling, alias);
    expect(() => sandboxChildEnv(root, { HOME: alias })).toThrow(/TEST SAFETY/);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked child temp directory escaping the run', () => {
    const alias = path.join(root, 'temp-alias');
    fs.symlinkSync('/outside-test-run', alias);
    expect(() => Bun.spawnSync([process.execPath, probe], { env: { ...sandboxChildEnv(root), TMPDIR: alias } })).toThrow(/TEST SAFETY/);
  });

  for (const name of ['TMPDIR', 'TEMP', 'TMP', 'MYCO_BIN_DIR']) it(`rejects a child ${name} in a sibling fixture`, () => {
    expect(() => Bun.spawnSync([process.execPath, probe], { env: { ...sandboxChildEnv(root), [name]: sibling } })).toThrow(/TEST SAFETY/);
  });

  it('resolves a relative binary destination from the child working directory', () => {
    const env = { ...sandboxChildEnv(root), MYCO_BIN_DIR: './bin' };
    expect(() => Bun.spawnSync([process.execPath, probe], { cwd: sibling, env })).toThrow(/TEST SAFETY/);
    expect(Bun.spawnSync([process.execPath, probe], { cwd: root, env }).exitCode).toBe(0);
  });

  it('rebinds inherited config homes when a test changes HOME', () => {
    const result = spawnSync(process.execPath, [probe], {
      env: { ...process.env, HOME: root, MYCO_TEST_CHILD_ROOT: root, TMPDIR: root, TEMP: root, TMP: root,
        CODEX_HOME: undefined, CLAUDE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, MYCO_HOME: undefined, USERPROFILE: undefined, MYCO_LAUNCH_AGENTS_DIR: undefined, MYCO_TEAM_HOME: undefined },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const seen = JSON.parse(result.stdout);
    for (const name of CHILD_HOME_NAMES) expect(path.relative(root, seen[name]).startsWith('..')).toBe(false);
  });
});
