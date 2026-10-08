import { afterAll, beforeAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-compiled-'));
const binary = path.join(root, 'myco-command-harness');
beforeAll(() => {
  const result = spawnSync(process.execPath, ['build', '--compile', './tests/fixtures/runner/service-cli.ts', '--outfile', binary], { env: sandboxChildEnv(root), cwd: process.cwd(), encoding: 'utf8', timeout: 120000 });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0 });
  if (process.platform === 'darwin') expect(spawnSync('codesign', ['--force', '--sign', '-', binary], { env: sandboxChildEnv(root), cwd: root, encoding: 'utf8' }).status).toBe(0);
}, 150000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const mode of ['member-only', 'runner-only', 'both']) {
  it(`compiled service verbs keep capture independent in ${mode}`, () => {
    const cwd = path.join(root, mode); fs.mkdirSync(cwd);
    const env = sandboxChildEnv(cwd);
    const run = (...args: string[]) => spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
    const prepared = run('prepare', mode);
    expect({ status: prepared.status, signal: prepared.signal, stderr: prepared.stderr }).toMatchObject({ status: 0 });
    const install = run('runner', 'install', '--server', 'https://compiled.invalid');
    expect(install.status).toBe(mode === 'member-only' ? 1 : 0);
    if (mode === 'member-only') expect(install.stderr).toContain('myco runner register https://compiled.invalid');
    else {
      expect(install.stdout).toContain('installed and started');
      expect(run('runner', 'status').stdout).toContain('runner service: running at login');
      const doctor = run('worker', 'doctor');
      expect(doctor.status).toBe(0);
      expect(doctor.stdout).toContain('harnesses offered: codex');
      expect(doctor.stdout).not.toContain('mycorun_');
      expect(run('runner', 'uninstall').stdout).toContain('The Deployment identity remains');
      expect(run('runner', 'status').stdout).toContain('runner service: not installed');
    }
    expect(fs.readFileSync(path.join(env.MYCO_HOME!, 'member', 'capture-sentinel'), 'utf8')).toBe('capture');
    expect(JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'fixture-service-state.json'), 'utf8')).loaded).toEqual([]);
  });
}
