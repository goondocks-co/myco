import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonClient, isIgnoredEventResponse } from '@myco/hooks/client';
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
          res.end(JSON.stringify({ ok: true, received: JSON.parse(body || '{}') }));
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
  });

  it('posts to daemon and returns data', async () => {
    const client = new DaemonClient(vaultDir);
    const result = await client.post('/events', { type: 'test' });
    expect(result.ok).toBe(true);
    expect(result.data.received.type).toBe('test');
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
