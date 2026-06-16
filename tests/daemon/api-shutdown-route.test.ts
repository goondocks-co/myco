import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';

// Server side of the cooperative-shutdown fix (#4). `POST /api/shutdown` lets a
// successor daemon (or the updater) trigger THIS daemon's graceful drain on
// Windows, where a cross-process SIGTERM is an uncatchable TerminateProcess.
// The route is a loopback-validated raw route (no auth — a DIFFERENT daemon
// calls it and can't hold this one's token), POST-only, and 503 until main.ts
// wires the shutdown closure via onShutdownRequest().

describe('POST /api/shutdown route', () => {
  let tmp: string;
  let logger: DaemonLogger;
  let server: DaemonServer;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-shutdown-route-'));
    const vaultDir = path.join(tmp, '.myco');
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    server = new DaemonServer({ vaultDir, logger });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function shutdownUrl(): string {
    return `http://127.0.0.1:${server.port}/api/shutdown`;
  }

  it('returns 503 before a shutdown handler is wired', async () => {
    const res = await fetch(shutdownUrl(), { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('shutdown_not_ready');
  });

  it('rejects non-POST methods with 405', async () => {
    server.onShutdownRequest(() => {});
    const res = await fetch(shutdownUrl(), { method: 'GET' });
    expect(res.status).toBe(405);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('method_not_allowed');
  });

  it('accepts a POST (202) and invokes the wired handler once', async () => {
    let calls = 0;
    let fired!: () => void;
    const handlerFired = new Promise<void>((r) => { fired = r; });
    server.onShutdownRequest(() => { calls += 1; fired(); });

    const res = await fetch(shutdownUrl(), { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json() as { myco: boolean; shutting_down: boolean };
    expect(body).toEqual({ myco: true, shutting_down: true });

    // The handler fires after the response body flushes — wait for it.
    await Promise.race([
      handlerFired,
      new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('handler never fired')), 2_000)),
    ]);
    expect(calls).toBe(1);
  });
});
