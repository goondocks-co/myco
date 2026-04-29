import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';

import { getRuntime, resolveProjectRuntimeCommand, stopProject } from '@myco-hub/daemon.js';
import type { ProjectRecord } from '@myco-hub/discovery.js';

describe('myco-hub daemon runtime', () => {
  let tmpRoot: string;
  let upstream: ChildProcessWithoutNullStreams | null;
  let project: ProjectRecord;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hub-daemon-'));
    const vaultDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');
    project = makeProject(tmpRoot, vaultDir);
    upstream = null;
  });

  afterEach(async () => {
    if (upstream && !upstream.killed) {
      upstream.kill('SIGTERM');
      await waitForExit(upstream).catch(() => upstream?.kill('SIGKILL'));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('trusts daemon.json only when the pid belongs to the project vault', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, version: '9.9.9' }));
        return;
      }
      res.writeHead(404).end();
    });
    await listen(server, await findAvailableTestPort());
    const port = (server.address() as { port: number }).port;
    fs.writeFileSync(path.join(project.vaultDir, 'daemon.json'), JSON.stringify({
      pid: process.pid,
      port,
      version: '9.9.9',
      started: '2026-04-24T00:00:00.000Z',
    }), 'utf-8');

    const runtime = await getRuntime(project);

    expect(runtime.status).toBe('stopped');
    await close(server);
  });

  it('stops the owned project daemon and removes stale daemon.json', async () => {
    const started = await startUpstream(tmpRoot);
    upstream = started.process;
    if (!upstream.pid) throw new Error('upstream pid missing');
    fs.writeFileSync(path.join(project.vaultDir, 'daemon.json'), JSON.stringify({
      pid: upstream.pid,
      port: started.port,
      version: '0.22.3',
      started: '2026-04-24T00:00:00.000Z',
    }), 'utf-8');

    const before = await getRuntime(project);
    expect(before.status).toBe('running');

    const after = await stopProject(project);

    expect(after.status).toBe('stopped');
    expect(fs.existsSync(path.join(project.vaultDir, 'daemon.json'))).toBe(false);
    expect(upstream.killed || upstream.exitCode !== null || upstream.signalCode !== null).toBe(true);
    upstream = null;
  });

  it('does not replay a registered generic Node runtime as a Myco CLI command', () => {
    project.runtimeCommand = process.execPath;
    const accessSync = vi.spyOn(fs, 'accessSync').mockImplementation((filePath) => {
      if (filePath === process.execPath) return undefined;
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    try {
      expect(resolveProjectRuntimeCommand(project)).toBeNull();
    } finally {
      accessSync.mockRestore();
    }
  });

  it('replays registered command names through PATH resolution', () => {
    project.runtimeCommand = 'myco-dev';
    expect(resolveProjectRuntimeCommand(project)).toBe('myco-dev');
  });
});

function makeProject(projectRoot: string, vaultDir: string): ProjectRecord {
  return {
    id: 'example-local-12345678',
    name: 'example',
    projectRoot,
    vaultDir,
    machineId: 'local_12345678',
    source: 'daemon-api',
    preferredPort: null,
    runtimeCommand: null,
    firstSeenAt: '2026-04-24T00:00:00.000Z',
    lastSeenAt: '2026-04-24T00:00:00.000Z',
  };
}

function listen(server: http.Server, port = 0): Promise<void> {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function close(server: http.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      error ? reject(error) : resolve();
    });
  });
}

async function startUpstream(cwd: string): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const port = await findAvailableTestPort();
  const code = `
const http = require('node:http');
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ myco: true, version: '0.22.3' }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port) + '\\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;
  const child = spawn(process.execPath, ['-e', code], {
    cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('upstream did not start')), 3000);
    child.once('error', reject);
    child.stdout.once('data', (chunk) => {
      clearTimeout(timeout);
      resolve({ process: child, port: Number(chunk.toString('utf-8').trim()) });
    });
  });
}

async function findAvailableTestPort(): Promise<number> {
  for (let port = 32000; port < 33000; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error('no test port available');
}

function canListen(port: number): Promise<boolean> {
  const server = http.createServer();
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}
