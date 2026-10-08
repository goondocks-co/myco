import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [binaryArgument, version] = process.argv.slice(2);
assert(binaryArgument && version, 'usage: node scripts/verify-release-binary.mjs <binary> <version>');
const binary = path.resolve(binaryArgument);
const scratch = fs.mkdtempSync(path.join(tmpdir(), 'myco-release-binary-'));
const home = path.join(scratch, 'home');
fs.mkdirSync(home);
const options = {
  cwd: scratch,
  env: {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    MYCO_HOME: path.join(home, '.myco'),
  },
};
let server;
let exited;
let output = '';
let spawnError;
try {
  assert.equal(execFileSync(binary, ['--version'], { ...options, encoding: 'utf8', timeout: 30_000 }).trim(), version);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  execFileSync(binary, ['server', 'create', '--target', 'local', '--port', String(port)], {
    ...options, stdio: 'pipe', timeout: 60_000,
  });
  server = spawn(binary, ['server', 'run', '--target', 'local', '--no-worker'], {
    ...options, stdio: ['ignore', 'pipe', 'pipe'],
  });
  exited = once(server, 'exit');
  exited.catch((error) => { spawnError = error; });
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  let healthy = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    assert(server.exitCode === null && server.signalCode === null, `Deployment exited before health: ${output}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) { healthy = true; break; }
    } catch (error) {
      if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error;
    }
    await delay(100);
  }
  assert(healthy, `Deployment did not become healthy: ${output}`);
  server.kill('SIGTERM');
  const [code, signal] = await Promise.race([
    exited,
    delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Deployment did not stop after SIGTERM'); }),
  ]);
  assert(code === 0 || signal === 'SIGTERM', `Deployment stopped with code ${code}, signal ${signal}: ${output}`);
  console.log(`Release binary ${version}: version, SQLite provisioning, health and shutdown verified`);
} finally {
  try {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await exited;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
