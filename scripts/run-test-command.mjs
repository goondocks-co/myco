#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createTestTempRun } from './test-temp-root.mjs';
import { sandboxTestHome } from './test-environment.mjs';

const run = createTestTempRun();
process.on('exit', () => {
  if (run.finish().length > 0 && !process.exitCode) process.exitCode = 1;
});
sandboxTestHome(run.root);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('A test command is required');
const child = spawn(command, args, { env: process.env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => { throw error; });
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
});
