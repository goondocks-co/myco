#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createTestTempRun, finishTestTempRun } from './test-temp-root.mjs';
import { sandboxTestHome } from './test-environment.mjs';
import { registerTestProcess, stopTestProcessGroup } from './test-process-tree.mjs';

const run = createTestTempRun();
let child;
function stopTree(signal) {
  if (!child?.pid) return;
  stopTestProcessGroup(child.pid, signal);
}
process.on('exit', () => finishTestTempRun(run, () => stopTree('SIGKILL')));
sandboxTestHome(run.root);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A test command is required');
child = spawn(command, args, { env: process.env, stdio: 'inherit', detached: process.platform !== 'win32' });
if (child.pid) registerTestProcess(child.pid, run.root);
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
