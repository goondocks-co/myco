import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createHookDaemonClient, DaemonClient, isIgnoredEventResponse } from '@myco/hooks/client';
import { REQUEST_CONTEXT_ENV, REQUEST_CONTEXT_HEADERS, resolveLegacyRequestContext } from '@myco/tools/request-context';
import { saveProjectManifest } from '@myco/config/project-manifest';
import { resolveProjectVaultDir, resolveServiceDaemonStatePath } from '@myco/grove/paths';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonClient', () => {
  let vaultDir: string;
  let mockServer: http.Server;
  let mockPort: number;

  beforeEach(async () => {
    // Suppress the fire-and-forget spawnDaemon side effect that post/get/put/
    // delete now trigger when the daemon is unreachable — tests assert the
    // request-level result; the spawn path has its own unit coverage.
    process.env.MYCO_NO_AUTO_SPAWN = '1';
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-'));

    mockServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid }));
      } else {
        let body = '';
        req.on('data', (c: string) => { body += c; });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, headers: req.headers, received: JSON.parse(body || '{}') }));
        });
      }
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        mockPort = (mockServer.address() as { port: number }).port;
        fs.writeFileSync(
          path.join(vaultDir, 'daemon.json'),
          JSON.stringify({ pid: process.pid, port: mockPort }),
        );
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => mockServer.close(() => r()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
    delete process.env.MYCO_NO_AUTO_SPAWN;
    delete process.env[REQUEST_CONTEXT_ENV.projectRoot];
    delete process.env[REQUEST_CONTEXT_ENV.projectId];
    delete process.env[REQUEST_CONTEXT_ENV.groveId];
    delete process.env[REQUEST_CONTEXT_ENV.machineId];
    delete process.env[REQUEST_CONTEXT_ENV.sessionId];
  });

  it('posts to daemon and returns data', async () => {
    const client = new DaemonClient(vaultDir);
    const result = await client.post('/events', { type: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data.received.type).toBe('test');
  });

  it('forwards constructor request context headers to daemon requests', async () => {
    const previousHome = process.env.MYCO_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-home-'));
    try {
      process.env.MYCO_HOME = tmpHome;
      const globalStatePath = resolveServiceDaemonStatePath(tmpHome);
      fs.mkdirSync(path.dirname(globalStatePath), { recursive: true });
      fs.writeFileSync(globalStatePath, JSON.stringify({ pid: process.pid, port: mockPort }));

      const context = resolveLegacyRequestContext(vaultDir, {
        projectRoot: '/workspace/project-a',
        projectId: 'project-a',
        groveId: 'grove-a',
        machineId: 'machine-a',
        sessionId: 'sess-a',
        source: 'explicit',
      });
      const client = new DaemonClient(vaultDir, { requestContext: context });

      const result = await client.post('/events', { type: 'test' });

      expect(result.ok).toBe(true);
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe('/workspace/project-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe('project-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe('grove-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.machineId]).toBe('machine-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-a');
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('creates hook clients from environment context and hook session id', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hook-context-'));
    const previousHome = process.env.MYCO_HOME;
    try {
      const home = path.join(tmp, 'home');
      process.env.MYCO_HOME = home;
      const projectRoot = path.join(tmp, 'project-a');
      const projectVaultDir = resolveProjectVaultDir(projectRoot);
      fs.mkdirSync(projectVaultDir, { recursive: true });
      const grove = createGrove('Work', home);
      saveProjectManifest(projectVaultDir, {
        project: { id: 'project-a', name: 'Project A' },
        grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
      });
      registerProjectInGrove(grove.id, {
        projectId: 'project-a',
        projectName: 'Project A',
        projectRoot,
        bindingId: 'gbind-a',
      }, home);
      const globalStatePath = resolveServiceDaemonStatePath(home);
      fs.mkdirSync(path.dirname(globalStatePath), { recursive: true });
      fs.writeFileSync(globalStatePath, JSON.stringify({ pid: process.pid, port: mockPort }));

      process.env[REQUEST_CONTEXT_ENV.projectRoot] = projectRoot;
      process.env[REQUEST_CONTEXT_ENV.projectId] = 'project-a';
      process.env[REQUEST_CONTEXT_ENV.groveId] = grove.id;
      process.env[REQUEST_CONTEXT_ENV.machineId] = 'machine-a';

      const client = createHookDaemonClient(vaultDir, { sessionId: 'sess-hook' });
      const result = await client.post('/events', { type: 'test' });

      expect(result.ok).toBe(true);
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe(projectRoot);
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.projectId]).toBe('project-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.groveId]).toBe(grove.id);
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.machineId]).toBe('machine-a');
      expect(result.data.headers[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-hook');
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns ok: false when daemon is not running', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-empty-'));
    const client = new DaemonClient(emptyDir);
    const result = await client.post('/events', { type: 'test' });
    expect(result.ok).toBe(false);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('returns ok: false when daemon.json points to dead port', async () => {
    await new Promise<void>((r) => mockServer.close(() => r()));
    const client = new DaemonClient(vaultDir);
    const result = await client.post('/events', { type: 'test' });
    expect(result.ok).toBe(false);
  });
});

describe('DaemonClient Grove service state', () => {
  const originalHome = process.env.MYCO_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    delete process.env.MYCO_NO_AUTO_SPAWN;
  });

  it('uses global daemon state and ignores stale project-local daemon.json for Grove-bound projects', async () => {
    process.env.MYCO_NO_AUTO_SPAWN = '1';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-global-client-'));
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'project-a');
    const projectVaultDir = resolveProjectVaultDir(projectRoot);
    fs.mkdirSync(projectVaultDir, { recursive: true });

    const grove = createGrove('Work', home);
    saveProjectManifest(projectVaultDir, {
      project: { id: 'project-a', name: 'Project A' },
      grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'project-a',
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind-a',
    }, home);

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: string) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, port: (server.address() as { port: number }).port, received: JSON.parse(body || '{}') }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const globalPort = (server.address() as { port: number }).port;
      const globalStatePath = resolveServiceDaemonStatePath(home);
      fs.mkdirSync(path.dirname(globalStatePath), { recursive: true });
      fs.writeFileSync(globalStatePath, JSON.stringify({ pid: process.pid, port: globalPort }));

      const localStatePath = path.join(projectVaultDir, 'daemon.json');
      fs.writeFileSync(localStatePath, JSON.stringify({ pid: 0x7fffffff, port: 45678 }));

      const client = new DaemonClient(projectVaultDir);
      const result = await client.post('/events', { type: 'test' });

      expect(result.ok).toBe(true);
      expect(result.data.port).toBe(globalPort);
      expect(result.data.received.type).toBe('test');
      expect(fs.existsSync(localStatePath)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Error-body propagation — parseErrorBody helper applied to all four methods.
// ---------------------------------------------------------------------------

type ErrorBodyMode =
  | { kind: 'json'; payload: unknown; status?: number }
  | { kind: 'empty'; status?: number }
  | { kind: 'invalid-json'; text: string; status?: number }
  | { kind: 'text-plain'; text: string; status?: number };

describe('DaemonClient error-body propagation', () => {
  let vaultDir: string;
  let mockServer: http.Server;
  let mode: ErrorBodyMode;

  beforeEach(async () => {
    process.env.MYCO_NO_AUTO_SPAWN = '1';
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-err-'));
    mode = { kind: 'json', payload: { error: { code: 'boom', message: 'test' } } };

    mockServer = http.createServer((_req, res) => {
      const status = ('status' in mode && mode.status) || 500;
      if (mode.kind === 'json') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mode.payload));
      } else if (mode.kind === 'empty') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end();
      } else if (mode.kind === 'invalid-json') {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(mode.text);
      } else if (mode.kind === 'text-plain') {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
        res.end(mode.text);
      }
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const port = (mockServer.address() as { port: number }).port;
        fs.writeFileSync(
          path.join(vaultDir, 'daemon.json'),
          JSON.stringify({ pid: process.pid, port }),
        );
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => mockServer.close(() => r()));
    fs.rmSync(vaultDir, { recursive: true, force: true });
    delete process.env.MYCO_NO_AUTO_SPAWN;
  });

  it('returns parsed JSON body on non-ok for post/put/get/delete', async () => {
    const payload = { error: { code: 'plan-remote', message: 'force_remote required' } };
    mode = { kind: 'json', payload };

    const client = new DaemonClient(vaultDir);
    const post = await client.post('/api/x', {});
    const put = await client.put('/api/x', {});
    const get = await client.get('/api/x');
    const del = await client.delete('/api/x');

    for (const r of [post, put, get, del]) {
      expect(r.ok).toBe(false);
      expect(r.data).toEqual(payload);
    }
  });

  it('returns data: undefined on empty non-ok body for all four methods', async () => {
    mode = { kind: 'empty' };
    const client = new DaemonClient(vaultDir);

    const post = await client.post('/api/x', {});
    const put = await client.put('/api/x', {});
    const get = await client.get('/api/x');
    const del = await client.delete('/api/x');

    for (const r of [post, put, get, del]) {
      expect(r.ok).toBe(false);
      expect(r.data).toBeUndefined();
    }
  });

  it('returns data: undefined when the non-ok body is invalid JSON', async () => {
    mode = { kind: 'invalid-json', text: '<<<not json>>>' };
    const client = new DaemonClient(vaultDir);

    const post = await client.post('/api/x', {});
    const put = await client.put('/api/x', {});
    const get = await client.get('/api/x');
    const del = await client.delete('/api/x');

    for (const r of [post, put, get, del]) {
      expect(r.ok).toBe(false);
      expect(r.data).toBeUndefined();
    }
  });

  it('returns data: undefined when the non-ok body is text/plain (non-JSON)', async () => {
    mode = { kind: 'text-plain', text: 'internal server error' };
    const client = new DaemonClient(vaultDir);

    const post = await client.post('/api/x', {});
    const put = await client.put('/api/x', {});
    const get = await client.get('/api/x');
    const del = await client.delete('/api/x');

    for (const r of [post, put, get, del]) {
      expect(r.ok).toBe(false);
      expect(r.data).toBeUndefined();
    }
  });
});

describe('isIgnoredEventResponse', () => {
  it('returns true when body carries a non-empty ignored string', () => {
    expect(isIgnoredEventResponse({ ok: true, ignored: 'ephemeral-sub-invocation' })).toBe(true);
    expect(isIgnoredEventResponse({ ignored: 'rule' })).toBe(true);
  });

  it('returns false for happy-path 200 responses with no ignored field', () => {
    expect(isIgnoredEventResponse({ ok: true })).toBe(false);
    expect(isIgnoredEventResponse({})).toBe(false);
  });

  it('returns false for nullish or non-object bodies', () => {
    expect(isIgnoredEventResponse(undefined)).toBe(false);
    expect(isIgnoredEventResponse(null)).toBe(false);
    expect(isIgnoredEventResponse('200 OK')).toBe(false);
  });

  it('returns false when ignored is present but empty or non-string', () => {
    expect(isIgnoredEventResponse({ ignored: '' })).toBe(false);
    expect(isIgnoredEventResponse({ ignored: null })).toBe(false);
    expect(isIgnoredEventResponse({ ignored: 42 })).toBe(false);
  });
});
