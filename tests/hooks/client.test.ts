import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonClient } from '@myco/hooks/client';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonClient', () => {
  let vaultDir: string;
  let mockServer: http.Server;
  let mockPort: number;

  beforeEach(async () => {
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
