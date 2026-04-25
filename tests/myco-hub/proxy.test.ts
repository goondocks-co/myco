import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';

import { proxyProjectRequest } from '@myco-hub/proxy.js';
import type { ProjectRecord } from '@myco-hub/discovery.js';

describe('myco-hub proxy', () => {
  let tmpRoot: string;
  let upstream: ChildProcessWithoutNullStreams;
  let upstreamPort: number;
  let proxy: http.Server;
  let project: ProjectRecord;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hub-proxy-'));
    const vaultDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n', 'utf-8');

    const started = await startUpstream(tmpRoot);
    upstream = started.process;
    upstreamPort = started.port;
    if (!upstream.pid) throw new Error('upstream pid missing');
    fs.writeFileSync(path.join(vaultDir, 'daemon.json'), JSON.stringify({
      pid: upstream.pid,
      port: upstreamPort,
      version: '0.22.3',
      started: '2026-04-24T00:00:00.000Z',
    }), 'utf-8');

    project = {
      id: 'example-local-12345678',
      name: 'example',
      projectRoot: tmpRoot,
      vaultDir,
      machineId: 'local_12345678',
      source: 'daemon-api',
      preferredPort: upstreamPort,
      runtimeCommand: null,
      firstSeenAt: '2026-04-24T00:00:00.000Z',
      lastSeenAt: '2026-04-24T00:00:00.000Z',
    };

    proxy = http.createServer((req, res) => {
      void proxyProjectRequest(project, '/p/example-local-12345678', req, res);
    });
    await listen(proxy);
  });

  afterEach(async () => {
    await close(proxy).catch(() => {});
    if (upstream && !upstream.killed) {
      upstream.kill('SIGTERM');
      await waitForExit(upstream).catch(() => upstream.kill('SIGKILL'));
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('maps proxied paths and forwards request bodies', async () => {
    const res = await fetch(`${proxyUrl()}/p/example-local-12345678/api/test?x=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"ok":true}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'POST', url: '/api/test?x=1', body: '{"ok":true}' });
  });

  it('rewrites HTML and preserves the project proxy prefix for the UI', async () => {
    const res = await fetch(`${proxyUrl()}/p/example-local-12345678/html`);
    const html = await res.text();

    expect(html).toContain('href="/p/example-local-12345678/sessions?myco_hub_proxy=1"');
    expect(html).toContain('window.__MYCO_HUB_PREFIX__ = prefix');
    expect(html).not.toContain('history.replaceState');
  });

  it('rewrites CSS absolute asset URLs', async () => {
    const res = await fetch(`${proxyUrl()}/p/example-local-12345678/style.css`);

    expect(await res.text()).toContain('url("/p/example-local-12345678/assets/bg.png?myco_hub_proxy=1")');
  });

  it('rewrites relative redirect locations through the proxy prefix', async () => {
    const res = await fetch(`${proxyUrl()}/p/example-local-12345678/redirect`, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/p/example-local-12345678/sessions');
  });

  it('can reject passive proxy requests without starting a stopped project', async () => {
    const stoppedProject = { ...project, preferredPort: null };
    fs.rmSync(path.join(stoppedProject.vaultDir, 'daemon.json'), { force: true });
    upstream.kill('SIGTERM');
    await waitForExit(upstream);

    const server = http.createServer((req, res) => {
      void proxyProjectRequest(stoppedProject, '/p/example-local-12345678', req, res, { startIfNeeded: false });
    });
    await listen(server);
    const address = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${address.port}/p/example-local-12345678/api/stats`);

    expect(res.status).toBe(503);
    await close(server);
  });

  function proxyUrl(): string {
    const address = proxy.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function startUpstream(cwd: string): Promise<{ process: ChildProcessWithoutNullStreams; port: number }> {
  const port = await findAvailableTestPort();
  const code = `
const http = require('node:http');
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString('utf-8'); });
  req.on('end', () => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, version: '0.22.3' }));
      return;
    }
    if (req.url && req.url.startsWith('/redirect')) {
      res.writeHead(302, { Location: '/sessions' });
      res.end();
      return;
    }
    if (req.url && req.url.startsWith('/style.css')) {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      res.end('body { background-image: url("/assets/bg.png"); }');
      return;
    }
    if (req.url && req.url.startsWith('/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head></head><body><a href="/sessions">Sessions</a></body></html>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body }));
  });
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
  for (let port = 31000; port < 32000; port++) {
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

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}
