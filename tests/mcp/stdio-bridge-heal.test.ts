/**
 * Integration test for the stdio-bridge self-heal PRIMITIVES.
 *
 * Why primitives and not the full bridge subprocess: spawning the real
 * bridge requires a populated Grove fixture (project.toml + grove
 * registry record + registered project under MYCO_HOME), because the
 * bridge's startup `requestContextFromEnvironment` resolves a fully-
 * scoped request context for header injection. That's a lot of test
 * scaffolding for the same fundamental assertion — that the bridge's
 * health probe AND its upstream-rebuild can transparently follow a
 * daemon across a restart on the same port.
 *
 * This test exercises those two primitives (`probeDaemonHealth`,
 * `buildUpstreamForCurrentDaemon`) against a real HTTP server that
 * mimics the daemon's /health surface. The kill+restart cycle the test
 * runs is the same shape as `make build` rebuilding the daemon under
 * a live session — the primitives MUST follow the port hop and the new
 * auth_token written to daemon.json. The orchestration loop
 * (`reconnectUpstream`) is a tight composition over these two
 * primitives plus the upstream-swap + handler-rewire pattern unit-
 * tested elsewhere — confidence by composition.
 *
 * Live verification with a session restart + daemon kill cycle stays
 * the definitive end-to-end check; this test is the always-on
 * regression guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { probeDaemonHealth } from '@myco/mcp/stdio-bridge.js';
import { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Fake daemon — minimal /health endpoint
// ---------------------------------------------------------------------------

function startFakeDaemon(port: number, pid: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid, port, version: 'fake' }));
        return;
      }
      // /mcp etc. — answer with 404 to keep the test focused on heal primitives.
      res.writeHead(404);
      res.end();
    });
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

function stopServer(srv: Server): Promise<void> {
  return new Promise((resolve) => {
    srv.closeAllConnections?.();
    srv.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// Tempdir + daemon.json
// ---------------------------------------------------------------------------

function writeDaemonJson(mycoHome: string, port: number, pid: number, authToken: string): void {
  // setDevServiceMode default is false; the resolver reads from `service/`.
  // We write both to be robust against an environment that auto-detects
  // dev-build mode based on cli path.
  for (const sub of ['service', 'service-dev']) {
    const dir = join(mycoHome, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'daemon.json'),
      JSON.stringify({
        pid,
        port,
        command: process.execPath,
        started: new Date().toISOString(),
        sessions: [],
        version: 'fake',
        auth_token: authToken,
      }),
      { encoding: 'utf-8' },
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stdio-bridge heal primitives — kill+restart cycle', () => {
  let mycoHome: string;
  let vaultDir: string;
  let priorMycoHome: string | undefined;
  let server: Server | null = null;
  let port: number;

  beforeEach(() => {
    mycoHome = mkdtempSync(join(tmpdir(), 'myco-bridge-heal-primitives-'));
    vaultDir = join(mycoHome, 'vault'); // any string works — buildUpstreamForCurrentDaemon only reads daemon.json
    mkdirSync(vaultDir, { recursive: true });
    priorMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    // Pick a high random port; in the unlikely event of collision, the
    // `srv.once('error', reject)` surfaces it and the test errors fast.
    port = 40_000 + Math.floor(Math.random() * 20_000);
  });

  afterEach(async () => {
    if (server) { await stopServer(server); server = null; }
    if (priorMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = priorMycoHome;
    rmSync(mycoHome, { recursive: true, force: true });
  });

  it('probeDaemonHealth: true on live /health, false on closed port, true again after restart', async () => {
    server = await startFakeDaemon(port, process.pid);
    expect(await probeDaemonHealth({ port })).toBe(true);

    await stopServer(server);
    server = null;
    await new Promise((r) => setTimeout(r, 100));
    expect(await probeDaemonHealth({ port })).toBe(false);

    // Restart on same port — primitive must succeed without state cache.
    server = await startFakeDaemon(port, process.pid + 1);
    expect(await probeDaemonHealth({ port })).toBe(true);
  });

  it('probeDaemonHealth: false when /health returns 503', async () => {
    server = await new Promise<Server>((resolve, reject) => {
      const srv = createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(404);
        res.end();
      });
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    expect(await probeDaemonHealth({ port })).toBe(false);
  });

  it('probeDaemonHealth: false when /health returns 200 but myco !== true', async () => {
    server = await new Promise<Server>((resolve, reject) => {
      const srv = createServer((req, res) => {
        if (req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ myco: false, pid: process.pid, port }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(srv));
    });
    expect(await probeDaemonHealth({ port })).toBe(false);
  });

  it('DaemonClient.getInfo: returns null when daemon.json is absent', () => {
    // No writeDaemonJson here — fresh mycoHome.
    const info = new DaemonClient(vaultDir).getInfo();
    expect(info).toBeNull();
  });

  it('DaemonClient.getInfo: picks up the latest port + auth_token from daemon.json on each call', () => {
    const initialAuth = randomBytes(16).toString('hex');
    writeDaemonJson(mycoHome, port, process.pid, initialAuth);

    const info1 = new DaemonClient(vaultDir).getInfo();
    expect(info1, 'first read must succeed against the seeded daemon.json').not.toBeNull();
    expect(info1!.port).toBe(port);
    expect(info1!.auth_token).toBe(initialAuth);

    // Simulate a daemon respawn — different pid, different auth_token,
    // same canonical port (the launchd KeepAlive shape). The bridge's
    // self-heal MUST pick up the new auth_token, otherwise its rebuilt
    // upstream sends with the stale token and the daemon returns 401.
    const newAuth = randomBytes(16).toString('hex');
    writeDaemonJson(mycoHome, port, process.pid + 1, newAuth);

    const info2 = new DaemonClient(vaultDir).getInfo();
    expect(info2, 'second read must follow the rewritten daemon.json').not.toBeNull();
    expect(info2!.auth_token).toBe(newAuth);
    expect(info2!.pid).toBe(process.pid + 1);
  });

  it('heal cycle composition: probe + getInfo together follow a daemon across a restart cycle', async () => {
    // Compose the two primitives the bridge's reconnectUpstream() loop
    // uses. Verifies: a live → dead → live cycle is observable via probe,
    // AND a fresh getInfo() after the restart picks up the new
    // auth_token. That's the contract the reconnect loop depends on.
    const authOriginal = randomBytes(16).toString('hex');
    writeDaemonJson(mycoHome, port, process.pid, authOriginal);
    server = await startFakeDaemon(port, process.pid);

    expect(await probeDaemonHealth({ port })).toBe(true);
    const initial = new DaemonClient(vaultDir).getInfo();
    expect(initial?.port).toBe(port);
    expect(initial?.auth_token).toBe(authOriginal);

    // Daemon dies — probe surfaces it immediately.
    await stopServer(server);
    server = null;
    expect(await probeDaemonHealth({ port })).toBe(false);

    // Daemon respawns on same port with new pid + new auth_token —
    // exactly what `make build` produces. The probe must succeed and
    // the next getInfo must pick up the new token (NOT the cached
    // original, which would 401 against the new daemon).
    const newAuth = randomBytes(16).toString('hex');
    writeDaemonJson(mycoHome, port, process.pid + 2, newAuth);
    server = await startFakeDaemon(port, process.pid + 2);

    expect(await probeDaemonHealth({ port })).toBe(true);
    const rebuilt = new DaemonClient(vaultDir).getInfo();
    expect(rebuilt?.port).toBe(port);
    expect(rebuilt?.auth_token).toBe(newAuth);
    expect(rebuilt?.pid).toBe(process.pid + 2);
  });
});
