import { expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from '../support/fenced-fs.mjs';
import { recoverAbandonedRunDirectories, RUN_DIRECTORY_MANIFEST } from '@myco/runner/run-directory.js';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { getMachineId } from '@myco/machine-id.js';

async function killed(child: ChildProcess): Promise<void> {
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
}

async function eventually<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic listing did not reach its expected state.');
}

it('recovers a crashed real model-listing allocation after its harness group is gone, preserving active listings and login targets', async () => {
  const base = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-model-recovery-')));
  const runs = join(base, 'runs');
  mkdirSync(runs);
  const fixtures: Array<{ child: ChildProcess; ready: { cwd: string; pid: number; home: string }; login: string }> = [];
  const start = async (name: string) => {
    const lane = join(base, name);
    const home = join(lane, 'home');
    const bin = join(lane, 'bin');
    mkdirSync(join(home, '.codex'), { recursive: true });
    mkdirSync(join(home, '.myco'));
    writeFileSync(join(home, '.myco', 'machine_id'), getMachineId());
    mkdirSync(bin);
    const login = join(home, '.codex', 'auth.json');
    writeFileSync(login, '{"tokens":{"fixture":"synthetic-login-target"}}');
    const ready = join(lane, 'ready.json');
    writeFileSync(join(bin, 'codex'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth-copy.json'), 'synthetic-retained-provider-key');
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({cwd:process.cwd(),pid:process.pid,home:process.env.CODEX_HOME}));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const script = join(lane, 'worker.ts');
    writeFileSync(script, `import { listHarnessModels } from ${JSON.stringify(resolve('packages/myco/src/runner/models.ts'))};
await listHarnessModels('codex', ${JSON.stringify(runs)}, new AbortController().signal);
`);
    const child = spawn(process.execPath, ['--no-env-file', script], { stdio: 'ignore', env: {
      ...process.env, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), MYCO_HOME: join(home, '.myco'), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    } });
    const state = await eventually(() => existsSync(ready) ? JSON.parse(readFileSync(ready, 'utf8')) as { cwd: string; pid: number; home: string } : null);
    const fixture = { child, ready: state, login };
    fixtures.push(fixture);
    return fixture;
  };
  try {
    const abandoned = await start('abandoned');
    const active = await start('active');
    const manifestFile = join(abandoned.ready.cwd, RUN_DIRECTORY_MANIFEST);
    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    expect(manifest).toMatchObject({ purpose: 'model-listing', harnessId: 'codex', pid: abandoned.child.pid, processGroups: [abandoned.ready.pid] });
    expect(manifest).not.toHaveProperty('projectId');
    expect(manifest).not.toHaveProperty('deploymentKey');
    await killed(abandoned.child);
    expect(recoverAbandonedRunDirectories(runs).recovered).toBe(0);
    process.kill(process.platform === 'win32' ? abandoned.ready.pid : -abandoned.ready.pid, 'SIGKILL');
    await eventually(() => recoverAbandonedRunDirectories(runs).recovered === 1 ? true : null);
    expect(existsSync(abandoned.ready.cwd)).toBe(false);
    expect(readFileSync(join(active.ready.home, 'auth-copy.json'), 'utf8')).toBe('synthetic-retained-provider-key');
    expect(readFileSync(abandoned.login, 'utf8')).toBe('{"tokens":{"fixture":"synthetic-login-target"}}');
    expect(readFileSync(active.login, 'utf8')).toBe('{"tokens":{"fixture":"synthetic-login-target"}}');
  } finally {
    for (const fixture of fixtures) {
      try { process.kill(process.platform === 'win32' ? fixture.ready.pid : -fixture.ready.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      if (fixture.child.exitCode === null && fixture.child.signalCode === null) await killed(fixture.child);
    }
  }
});
