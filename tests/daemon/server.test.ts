import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('DaemonServer', () => {
  let vaultDir: string;
  let logger: DaemonLogger;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-srv-'));
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
  });

  afterEach(async () => {
    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('starts on a random port and writes daemon.json', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.port).toBeGreaterThan(0);
    expect(info.pid).toBe(process.pid);

    await server.stop();
  });

  it('responds to /health with myco: true', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await res.json();
    expect(body.myco).toBe(true);
    expect(body.pid).toBe(process.pid);

    await server.stop();
  });

  it('returns 404 for unknown routes', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const res = await fetch(`http://127.0.0.1:${server.port}/unknown`);
    expect(res.status).toBe(404);

    await server.stop();
  });

  it('cleans up daemon.json on stop', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();
    await server.stop();

    expect(fs.existsSync(path.join(vaultDir, 'daemon.json'))).toBe(false);
  });

  it('registers routes for /sessions/register and /sessions/unregister', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    const { SessionRegistry } = await import('@myco/daemon/lifecycle');
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty: () => {} });

    server.registerRoute('POST', '/sessions/register', async (req: any) => {
      registry.register(req.body.session_id);
      return { body: { ok: true, sessions: registry.sessions } };
    });

    server.registerRoute('POST', '/sessions/unregister', async (req: any) => {
      registry.unregister(req.body.session_id);
      return { body: { ok: true, sessions: registry.sessions } };
    });

    await server.start();

    const regRes = await fetch(`http://127.0.0.1:${server.port}/sessions/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'test-session' }),
    });
    expect((await regRes.json()).sessions).toContain('test-session');

    const unregRes = await fetch(`http://127.0.0.1:${server.port}/sessions/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'test-session' }),
    });
    expect((await unregRes.json()).sessions).not.toContain('test-session');

    await server.stop();
  });
});
