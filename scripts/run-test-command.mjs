#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createTestTempRun } from './test-temp-root.mjs';
import { sandboxTestHome } from './test-environment.mjs';

const run = createTestTempRun();
let child;
function stopTree(signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.error) throw result.error;
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
process.on('exit', () => {
  stopTree('SIGKILL');
  if (run.finish().length > 0 && !process.exitCode) process.exitCode = 1;
});
sandboxTestHome(run.root);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A test command is required');
child = spawn(command, args, { env: process.env, stdio: 'inherit', detached: process.platform !== 'win32' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopTree(signal);
    setTimeout(() => stopTree('SIGKILL'), 1000).unref();
  });
}
child.on('error', (error) => { throw error; });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
});
