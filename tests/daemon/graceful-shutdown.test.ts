/**
 * Regression test: `http.Server.close()` blocks on any open connection
 * until the *client* disconnects — keep-alives and WebSocket upgrades
 * can hold a Node HTTP server open for ~90s after we asked it to stop.
 * Live dogfood reproduction: every dev daemon restart appeared
 * "broken" for ~87s because the old daemon's HTTP server was waiting
 * on UI keep-alives + MCP bridge sockets to time out from the client
 * side.
 *
 * `gracefullyCloseHttpServer` forces the issue: drop idle keep-alives
 * immediately, then yank anything still hanging on after the grace
 * window. This test pins both behaviors with real sockets so a
 * regression on either step (e.g. dropping the closeAllConnections
 * call, or relying on a long grace) shows up in CI.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';
import { gracefullyCloseHttpServer } from '@myco/daemon/server.js';

interface RunningServer {
  port: number;
  server: http.Server;
  hung?: HungSignal;
}

interface HungSignal {
  arrived: Promise<void>;
}

async function startServer(): Promise<RunningServer & { hung: HungSignal }> {
  let signalArrived!: () => void;
  const arrived = new Promise<void>((resolve) => {
    signalArrived = resolve;
  });

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/long-poll') {
      // Hold the response open until the client disconnects. Models
      // an SSE / long-poll endpoint that the old daemon's UI uses.
      // Signal the test as soon as the server has the request in hand
      // so we don't race on `setTimeout`-based settling.
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      signalArrived();
      // Never write more; never end. Force-close should still kill it.
      return;
    }
    res.writeHead(404);
    res.end();
  });
  // Default keep-alive timeout is 5s. Bump up so the OS doesn't help us
  // by closing keep-alives on its own — we want to prove the fast-
  // shutdown helper is doing the work.
  server.keepAliveTimeout = 60_000;
  server.headersTimeout = 65_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, port: address.port, hung: { arrived } };
}

describe('gracefullyCloseHttpServer', () => {
  let running: RunningServer | null = null;

  afterEach(async () => {
    if (running && running.server.listening) {
      await new Promise<void>((resolve) => running!.server.close(() => resolve()));
    }
    running = null;
  });

  it('resolves quickly with no open connections', async () => {
    running = await startServer();
    const start = Date.now();
    await gracefullyCloseHttpServer(running.server, { gracePeriodMs: 1_000 });
    // With no open sockets, close() resolves via its callback well before
    // the 1s force-close grace fires. The bound proves resolution happens
    // nowhere near the 60s keep-alive timeout configured above (the
    // regression this guards against), NOT a sub-500ms perf budget — so it
    // is set comfortably below the keep-alive while tolerating
    // close-callback scheduling jitter on a loaded CI runner.
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(running.server.listening).toBe(false);
  });

  it('drops idle keep-alives without waiting for them to time out', async () => {
    running = await startServer();
    // Open a keep-alive socket and complete one request so the
    // connection lingers as idle keep-alive.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: running!.port, path: '/health', agent },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });

    const start = Date.now();
    await gracefullyCloseHttpServer(running.server, { gracePeriodMs: 1_000 });
    const elapsed = Date.now() - start;
    agent.destroy();
    // Without closeIdleConnections this would wait for the agent's
    // keep-alive timeout (default 5s, raised to 60s above). The bound
    // proves the idle keep-alive was dropped immediately rather than
    // waited out — it is set well below the 60s keep-alive (so a
    // regression to "waits for the keep-alive" is caught decisively)
    // while tolerating close-callback scheduling jitter on a loaded CI
    // runner. It is not a tight perf assertion.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('force-closes hung connections after the grace window', async () => {
    running = await startServer();
    const agent = new http.Agent({ keepAlive: true });
    // Fire-and-forget request to /long-poll — the server-side handler
    // never calls `res.end()`. We do NOT await any client-side
    // completion event: we wait on the server's `hung.arrived` signal
    // (resolved inside the request handler) so we know the connection
    // is registered with the server before we ask it to shut down.
    const req = http.request({
      host: '127.0.0.1',
      port: running.port,
      path: '/long-poll',
      agent,
    });
    req.on('error', () => { /* expected when the socket is force-closed */ });
    req.end();
    await running.hung!.arrived;

    const start = Date.now();
    await gracefullyCloseHttpServer(running.server, { gracePeriodMs: 200 });
    const elapsed = Date.now() - start;
    agent.destroy();
    // Lower bound proves the force-close waited the full grace window
    // (it did NOT yank the socket early). Upper bound proves it resolved
    // well under the 60s keep-alive timeout configured above — i.e. the
    // force-close fired rather than blocking on the dangling /long-poll
    // socket until the client-side keep-alive expired. The 5s ceiling is
    // 25× the 200ms grace yet 12× below the 60s keep-alive, so it still
    // unambiguously distinguishes "force-closed" from "waited for the
    // keep-alive" while tolerating event-loop/force-close scheduling
    // jitter on a loaded CI runner. It is deliberately NOT a tight perf
    // assertion.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(5_000);
  });
});
