import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { spawn } from 'node:child_process';
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

  it('does not delete daemon.json on stop if another daemon has taken over', async () => {
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    // Simulate a successor daemon overwriting daemon.json with a different PID
    const jsonPath = path.join(vaultDir, 'daemon.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ pid: 999888, port: 55555, started: new Date().toISOString(), sessions: [] }));

    await server.stop();

    // daemon.json should still exist — the successor owns it
    expect(fs.existsSync(jsonPath)).toBe(true);
    const info = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    expect(info.pid).toBe(999888);
  });

  it('evicts an existing daemon on startup', async () => {
    // Spawn a dummy process that stays alive until killed
    const dummy = spawn('node', ['-e', 'setTimeout(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    });
    const dummyPid = dummy.pid!;
    dummy.unref();

    // Write a daemon.json pointing at the dummy process
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: dummyPid, port: 99999, started: new Date().toISOString(), sessions: [] }),
    );

    // Evicting + starting a new server should kill the dummy
    const server = new DaemonServer({ vaultDir, logger });
    await server.evictExistingDaemon();
    await server.start();

    // The dummy process should be dead
    let alive = false;
    try { process.kill(dummyPid, 0); alive = true; } catch { /* dead */ }
    expect(alive).toBe(false);

    // daemon.json should now point at the new server
    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.pid).toBe(process.pid);

    await server.stop();
  });

  it('handles stale daemon.json with dead PID gracefully', async () => {
    // Write daemon.json with a PID that doesn't exist
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: 999999, port: 99999, started: new Date().toISOString(), sessions: [] }),
    );

    // Should start without error
    const server = new DaemonServer({ vaultDir, logger });
    await server.start();

    const info = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8'));
    expect(info.pid).toBe(process.pid);

    await server.stop();
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
