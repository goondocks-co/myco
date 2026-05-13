/**
 * Regression test: the daemon's HTTP server stays responsive under a
 * burst of concurrent localhost connections. Without protective
 * limits + an explicit listen backlog, Node's defaults let 250+
 * concurrent `/health` probes pile up CLOSE_WAIT sockets faster than
 * the daemon could drain — exhausting the launchd-capped fd table
 * (256 NOFILE on macOS) and triggering EMFILE on `accept()`. New
 * clients then couldn't even complete the TCP handshake (SYN_SENT).
 *
 * The smoke we ran on the live dev daemon caught this exact failure
 * mode at 250 connections. With `applyDaemonHttpServerLimits` + the
 * explicit listen backlog from `DAEMON_HTTP_LISTEN_BACKLOG`, the
 * server now drains bursts cleanly.
 *
 * What this test does NOT cover: the launchd `SoftResourceLimits` /
 * systemd `LimitNOFILE` raises (those live in the plist/unit
 * generators and are covered by tests/service/*). This file proves
 * the Node-level config side of the fix.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import http from 'node:http';
import {
  applyDaemonHttpServerLimits,
  DAEMON_HTTP_LISTEN_BACKLOG,
} from '@myco/daemon/server.js';

interface RunningServer {
  port: number;
  server: http.Server;
}

async function startServer(): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  applyDaemonHttpServerLimits(server);
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', DAEMON_HTTP_LISTEN_BACKLOG, resolve),
  );
  const address = server.address() as { port: number };
  return { server, port: address.port };
}

describe('applyDaemonHttpServerLimits', () => {
  let running: RunningServer | null = null;

  afterEach(async () => {
    if (running && running.server.listening) {
      running.server.closeAllConnections?.();
      await new Promise<void>((resolve) => running!.server.close(() => resolve()));
    }
    running = null;
  });

  test('sets a short keep-alive timeout', async () => {
    running = await startServer();
    expect(running.server.keepAliveTimeout).toBeLessThanOrEqual(5_000);
  });

  test('sets a tight headers timeout (well below the 60s Node default)', async () => {
    running = await startServer();
    expect(running.server.headersTimeout).toBeLessThanOrEqual(10_000);
  });

  test('caps maxRequestsPerSocket so one client cannot monopolize a socket forever', async () => {
    running = await startServer();
    const cap = running.server.maxRequestsPerSocket ?? 0;
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  test('explicit listen backlog is high enough for a localhost burst', () => {
    // 4096 is well above macOS's typical `kern.ipc.somaxconn` cap (often
    // 128) — so even when the kernel applies its own cap, we're at least
    // requesting more than Node's silent default.
    expect(DAEMON_HTTP_LISTEN_BACKLOG).toBeGreaterThanOrEqual(1024);
  });

  test('drains a burst of 200 concurrent /health probes without errors', async () => {
    running = await startServer();
    const url = `http://127.0.0.1:${running.port}/health`;
    const start = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, async () => {
        const res = await fetch(url);
        // body must be consumed for the socket to release in keep-alive
        // mode — uncomsumed bodies leave the connection hot.
        await res.text();
        return res.status;
      }),
    );
    const elapsed = Date.now() - start;
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<PromiseFulfilledResult<number>>;
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(rejected.length).toBe(0);
    expect(fulfilled.length).toBe(200);
    expect(fulfilled.every((r) => r.value === 200)).toBe(true);
    // 200 sub-millisecond responses on loopback should resolve in well
    // under a second, even on a busy CI box.
    expect(elapsed).toBeLessThan(5_000);
  });
});
