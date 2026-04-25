import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createHubServer } from '@myco-hub/server.js';
import { loadConfig } from '@myco-hub/paths.js';

describe('myco-hub server routes', () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createHubServer();
    await listen(server);
  });

  afterEach(async () => {
    await close(server);
  });

  it('redirects browser visits to the daemon registration endpoint back to the hub', async () => {
    const res = await fetch(`${serverUrl()}/api/daemon/register`, { redirect: 'manual' });

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
  });

  it('rejects mutating requests from a non-hub host before routing', async () => {
    const res = await request('/api/projects/missing/start', {
      method: 'POST',
      headers: {
        Host: 'example.test',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(res.body).toBe('{"error":"forbidden_host"}');
  });

  it('requires JSON for same-host mutating requests', async () => {
    const config = loadConfig();
    const res = await request('/api/projects/missing/start', {
      method: 'POST',
      headers: {
        Host: `127.0.0.1:${config.port}`,
        'Content-Type': 'text/plain',
      },
      body: '{}',
    });

    expect(res.status).toBe(415);
    expect(res.body).toBe('{"error":"unsupported_media_type"}');
  });

  function serverUrl(): string {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  function request(pathname: string, options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }> {
    const address = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: pathname,
        method: options.method,
        headers: options.headers,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString('utf-8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
});

function listen(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
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
