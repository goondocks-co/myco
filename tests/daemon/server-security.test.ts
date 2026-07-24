/**
 * CSRF / Origin / Content-Type gate on the DaemonServer.
 *
 * The daemon listens only on 127.0.0.1 but any web page the user visits
 * can still issue cross-origin POSTs. These tests pin down the middleware
 * that rejects forbidden hosts/origins and non-JSON mutating bodies, so
 * a regression cannot silently re-open the CSRF window that enables SSRF
 * exfiltration of the daemon's stored provider API keys.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DaemonServer } from '@myco/daemon/server';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { DaemonLogger } from '@myco/daemon/logger';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonServer CSRF/Origin/Content-Type gate', () => {
  let vaultDir: string;
  let logger: DaemonLogger;
  let server: DaemonServer;

  beforeEach(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-sec-'));
    ensureProjectManifest(vaultDir, { projectName: 'sec-test' });
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    server = new DaemonServer({
      vaultDir,
      logger,
      lockNamespace: testPerUserLockNamespace,
    });
    // A representative mutating route and a representative DELETE route.
    server.registerRoute('POST', '/test/echo', async (req) => ({ body: { ok: true, received: req.body } }));
    server.registerRoute('DELETE', '/test/thing/:id', async (req) => ({ body: { ok: true, id: req.params.id } }));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  async function request(method: string, path: string, headers: Record<string, string>, body?: string) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers, body });
  }

  it('rejects bogus Origin headers on POST with 403', async () => {
    const res = await request('POST', '/test/echo', {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(403);
  });

  it('allows Origin: http://localhost:<port>', async () => {
    const res = await request('POST', '/test/echo', {
      Origin: `http://localhost:${server.port}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
  });

  it('allows Origin: http://127.0.0.1:<port>', async () => {
    const res = await request('POST', '/test/echo', {
      Origin: `http://127.0.0.1:${server.port}`,
      'Content-Type': 'application/json',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
  });

  it('allows requests with no Origin header (curl, MCP, etc.)', async () => {
    const res = await request('POST', '/test/echo', {
      'Content-Type': 'application/json',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
  });

  it('rejects POST with a bogus Host header with 403', async () => {
    // fetch() sets Host automatically; override via manual TCP to simulate
    // an attacker rewriting Host. Use Node's http module directly.
    const http = await import('node:http');
    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: '/test/echo',
        headers: {
          Host: 'evil.example',
          'Content-Type': 'application/json',
          'Content-Length': 2,
        },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      });
      req.on('error', reject);
      req.write('{}');
      req.end();
    });
    expect(result.status).toBe(403);
  });

  it('returns 415 on POST with Content-Type: text/plain and a JSON body', async () => {
    const res = await request('POST', '/test/echo', {
      'Content-Type': 'text/plain',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(415);
  });

  it('accepts POST with Content-Type: application/json; charset=utf-8', async () => {
    const res = await request('POST', '/test/echo', {
      'Content-Type': 'application/json; charset=utf-8',
    }, JSON.stringify({ hello: 'world' }));
    expect(res.status).toBe(200);
  });

  it('allows DELETE with no body and no Content-Type', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/test/thing/42`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
  });

  it('returns 415 on DELETE with Content-Type: text/plain and a JSON body', async () => {
    const res = await request('DELETE', '/test/thing/42', {
      'Content-Type': 'text/plain',
    }, JSON.stringify({ force_remote: true }));
    expect(res.status).toBe(415);
  });

  it('GET requests bypass the Content-Type gate', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
  });
});
