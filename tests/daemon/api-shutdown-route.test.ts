import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonServer } from '@myco/daemon/server.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
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
    server = new DaemonServer({
      vaultDir,
      logger,
      lockNamespace: testPerUserLockNamespace,
    });
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

  it('publishes the retired external MCP activation posture in health', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as { external_mcp_activation?: string };
    expect(body.external_mcp_activation).toBe('retired');
  });

  it('returns 503 before a shutdown handler is wired', async () => {
    const res = await fetch(shutdownUrl(), { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('shutdown_not_ready');
  });

  it('rejects non-POST methods with 405', async () => {
    server.onShutdownRequest(async () => () => {});
    const res = await fetch(shutdownUrl(), { method: 'GET' });
    expect(res.status).toBe(405);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('method_not_allowed');
  });

  it('accepts only after preparation and invokes the returned continuation once', async () => {
    let prepareCalls = 0;
    let continuationCalls = 0;
    let fired!: () => void;
    const handlerFired = new Promise<void>((r) => { fired = r; });
    server.onShutdownRequest(async () => {
      prepareCalls += 1;
      return () => {
        continuationCalls += 1;
        fired();
      };
    });

    const res = await fetch(shutdownUrl(), { method: 'POST' });
    expect(res.status).toBe(202);
    const body = await res.json() as { myco: boolean; shutting_down: boolean };
    expect(body).toEqual({ myco: true, shutting_down: true });
    expect(prepareCalls).toBe(1);

    await Promise.race([
      handlerFired,
      new Promise<void>((_r, reject) => setTimeout(() => reject(new Error('handler never fired')), 2_000)),
    ]);
    expect(continuationCalls).toBe(1);
  });

  it('returns 409 without a continuation when preparation refuses', async () => {
    server.onShutdownRequest(async () => {
      throw new Error('containment refused');
    });

    const res = await fetch(shutdownUrl(), { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'shutdown_blocked' });
  });
});
