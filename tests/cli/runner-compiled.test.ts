import { afterAll, beforeAll, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { getLibsqlitePath, getVec0Path, getRipgrepPath } from '@myco/runtime/native-deps.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-compiled-'));
const binary = path.join(root, 'myco');
beforeAll(() => {
  const result = spawnSync(process.execPath, ['build', '--compile', './tests/fixtures/runner/service-cli.ts', '--outfile', binary], { env: sandboxChildEnv(root), cwd: process.cwd(), encoding: 'utf8', timeout: 120000 });
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toMatchObject({ status: 0 });
  if (process.platform === 'darwin') expect(spawnSync('codesign', ['--force', '--sign', '-', binary], { env: sandboxChildEnv(root), cwd: root, encoding: 'utf8' }).status).toBe(0);
}, 150000);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const mode of ['member-only', 'runner-only', 'both']) {
  it(`compiled login, join, provision and native server create no executor in ${mode}`, async () => {
    const cwd = path.join(root, `bootstrap-${mode}`); fs.mkdirSync(cwd);
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port; await reservation.stop(true);
    const env = sandboxChildEnv(path.join(cwd, 'home'), {
      MYCO_FIXTURE_PORT: String(port),
      MYCO_FIXTURE_PACKAGE_ROOT: path.resolve('packages/myco'), MYCO_FIXTURE_LIBSQLITE: getLibsqlitePath()!,
      MYCO_FIXTURE_VEC0: getVec0Path(), MYCO_FIXTURE_RG: getRipgrepPath(),
    });
    const invoke = (...args: string[]) => spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 30000 });
    expect(spawnSync('git', ['init', '-q'], { cwd, env }).status).toBe(0);
    expect(invoke('prepare', mode).status).toBe(0);
    for (const args of [
      ['login', 'https://compiled.invalid/join#' + 'i'.repeat(43), '--no-agents'],
      ['login', 'https://compiled.invalid', '--no-agents'], ['join'], ['join', '--no-worker'], ['join', '--provision', 'codex'], ['provision'],
    ]) {
      const result = invoke(...args);
      expect({ command: args[0], status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
      expect(result.stdout).not.toContain('a worker now runs');
      const state = JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'fixture-service-state.json'), 'utf8'));
      expect(state.commands).toEqual([]); expect(state.loaded).toEqual([]); expect(state.running).toEqual([]);
    }
    const child = spawn(binary, ['server'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { error += chunk; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    let exit: number | null;
    try {
      for (let i = 0; i < 400 && !output.includes('Deployment serving on'); i++) await new Promise(resolve => setTimeout(resolve, 25));
      const address = output.match(/Deployment serving on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      expect({ output, error, address }).toMatchObject({ address: expect.any(String) });
      expect((await fetch(`${address}/health`)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(output).toContain('myco runner register'); expect(output).toContain('this machine or another');
      expect(fs.existsSync(path.join(env.MYCO_HOME!, 'unexpected-executor-request'))).toBe(false);
      expect(fs.existsSync(path.join(env.HOME!, 'Library', 'LaunchAgents'))).toBe(false);
      expect(fs.existsSync(path.join(env.HOME!, '.config', 'systemd', 'user'))).toBe(false);
    } finally {
      child.kill('SIGTERM');
      exit = await exited;
    }
    expect(exit).toBe(0);
  }, 60000);

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
      expect(doctor.stdout).toContain('harnesses offered: unknown');
      expect(doctor.stdout).not.toContain('mycorun_');
      expect(run('runner', 'uninstall').stdout).toContain('The Deployment identity remains');
      expect(run('runner', 'status').stdout).toContain('runner service: not installed');
    }
    expect(fs.readFileSync(path.join(env.MYCO_HOME!, 'member', 'capture-sentinel'), 'utf8')).toBe('capture');
    expect(JSON.parse(fs.readFileSync(path.join(env.MYCO_HOME!, 'fixture-service-state.json'), 'utf8')).loaded).toEqual([]);
  });
}
