/**
 * DaemonClient.getInfoAsync — fallback discovery semantics.
 *
 * Adds the coverage Bucket G called for: a real HTTP server returning
 * each fixture (200 OK with myco:true+valid pid, malformed JSON, 503,
 * connection refused, dead-pid response) and the right DaemonInfo / null
 * coming back from getInfoAsync's discoverViaHealth fallback.
 *
 * The fallback path activates only when daemon.json is missing. Each
 * test stands up a temp MYCO_HOME, deletes any state file, binds an
 * http server on the canonical port for that home, and observes the
 * client's response.
 *
 * Includes a regression assertion for the dead-pid fix that landed in
 * Bucket C: `discoverViaHealth` must cross-check the response's pid
 * against the local OS and refuse to return a DaemonInfo for a pid
 * that does not exist.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DaemonClient } from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import { resolveGlobalDaemonPort } from '@myco/daemon/service-state';
import { canBindPort } from '../helpers/net.js';

let vaultDir: string;
let mycoHome: string;
let canonicalPort: number;
let server: http.Server | null;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.MYCO_HOME;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-get-info-async-'));
    mycoHome = path.join(vaultDir, 'home');
    canonicalPort = resolveGlobalDaemonPort(mycoHome);
    if (await canBindPort(canonicalPort)) {
      fs.mkdirSync(mycoHome, { recursive: true });
      process.env.MYCO_HOME = mycoHome;
      ensureProjectManifest(vaultDir, { projectName: 'getinfoasync-test' });

      // Make sure no stale daemon.json exists — discoverViaHealth must be hit.
      const statePath = resolveServiceDaemonStatePath(mycoHome);
      try { fs.unlinkSync(statePath); } catch { /* gone */ }
      server = null;
      return;
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  }
  throw new Error('Could not find a bindable derived daemon port for getInfoAsync tests');
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
  }
  fs.rmSync(vaultDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = previousHome;
});

async function startServer(handler: http.RequestListener): Promise<void> {
  server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(canonicalPort, '127.0.0.1', () => resolve());
  });
}

describe('DaemonClient.getInfoAsync — discoverViaHealth fallback', () => {
  it('returns the reconstructed DaemonInfo when /health responds with myco:true + live pid', async () => {
    await startServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid }));
      } else {
        res.writeHead(404).end();
      }
    });
    const client = new DaemonClient(vaultDir);
    const info = await client.getInfoAsync();
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.port).toBe(canonicalPort);
  });

  it('returns null when /health reports myco:false', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: false, pid: process.pid }));
    });
    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('returns null when /health body is malformed JSON', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('this is not json {{');
    });
    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('returns null when /health responds 503', async () => {
    await startServer((_req, res) => {
      res.writeHead(503).end('unavailable');
    });
    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('returns null when nothing is bound to the canonical port (ECONNREFUSED)', async () => {
    // No server started — connection should refuse fast.
    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('returns null when /health reports a fabricated dead pid (Bucket C dead-pid guard)', async () => {
    // Pid 1 is init on POSIX and always alive; we need a pid that is
    // *very* likely to be free. Use a large random offset above process.pid
    // and skip if it happens to be alive (rare, but cheap to defend).
    let deadPid = process.pid + 1_000_000;
    while (deadPid < 2_000_000) {
      try {
        process.kill(deadPid, 0);
        deadPid += 1; // alive somehow — try another
      } catch {
        break; // not alive — perfect
      }
    }

    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, pid: deadPid }));
    });
    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('prefers daemon.json when present and never hits discoverViaHealth', async () => {
    // Write daemon.json pointing at a non-existent port. If getInfoAsync
    // skipped the file and fell back to /health, the test would block on
    // the dead port; instead it must return the file's contents directly.
    const statePath = resolveServiceDaemonStatePath(mycoHome);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: 1 }));

    const client = new DaemonClient(vaultDir);
    const info = await client.getInfoAsync();
    expect(info).not.toBeNull();
    expect(info!.port).toBe(1);
    expect(info!.pid).toBe(process.pid);
  });
});
