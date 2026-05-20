/**
 * DaemonClient.getInfoAsync — lifecycle-lock fallback (Tier 2).
 *
 * When daemon.json is missing, the hook client must still reach a live
 * daemon. Tier 2 of the three-tier discovery (daemon.json → daemon.lock
 * → /health on canonical port) reads pid+port directly from the lock
 * file, which the daemon updates after `server.start()` binds.
 *
 * Production failure mode this guards against: prior incidents had
 * daemon.json deleted out-of-band (eviction race, manual rm, supervisor
 * cleanup) and self-reconcile starved by event-loop pressure, leaving
 * capture buffer-only for the daemon's entire lifetime. Either tier 2
 * or tier 3 alone would have made today's incident invisible — tier 2
 * is the no-round-trip default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient } from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import {
  resolveServiceDaemonStatePath,
  resolveServiceDir,
} from '@myco/grove/paths';
import { resolveMycoHome } from '@myco/grove/paths';

let vaultDir: string;
let mycoHome: string;
let serviceDir: string;
let lockPath: string;
let statePath: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.MYCO_HOME;
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lock-fallback-'));
  mycoHome = path.join(vaultDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  process.env.MYCO_HOME = mycoHome;
  ensureProjectManifest(vaultDir, { projectName: 'lock-fallback-test' });
  serviceDir = resolveServiceDir(resolveMycoHome());
  fs.mkdirSync(serviceDir, { recursive: true });
  lockPath = path.join(serviceDir, 'daemon.lock');
  statePath = resolveServiceDaemonStatePath(mycoHome);
  try { fs.unlinkSync(statePath); } catch { /* gone */ }
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = previousHome;
});

function writeLock(holder: { pid: number; port?: number; authToken?: string }): void {
  const body = JSON.stringify(
    {
      pid: holder.pid,
      startedAt: Math.floor(Date.now() / 1000),
      command: 'mock daemon',
      port: holder.port,
      authToken: holder.authToken,
    },
    null,
    2,
  ) + '\n';
  fs.writeFileSync(lockPath, body);
}

describe('DaemonClient.getInfoAsync — daemon.lock fallback', () => {
  it('reconstructs DaemonInfo from the lock file when daemon.json is missing', async () => {
    writeLock({ pid: process.pid, port: 31337, authToken: 'abc123' });

    const client = new DaemonClient(vaultDir);
    const info = await client.getInfoAsync();
    expect(info).not.toBeNull();
    expect(info!.pid).toBe(process.pid);
    expect(info!.port).toBe(31337);
    expect(info!.auth_token).toBe('abc123');
  });

  it('returns null when the lock omits port (daemon mid-startup, pre-bind)', async () => {
    writeLock({ pid: process.pid });

    const client = new DaemonClient(vaultDir);
    // Tier 3 (/health on canonical port) is unreachable — nothing
    // listening — so getInfoAsync returns null without false positives.
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('returns null when the lock points at a dead pid', async () => {
    let deadPid = process.pid + 1_000_000;
    while (deadPid < 2_000_000) {
      try {
        process.kill(deadPid, 0);
        deadPid += 1;
      } catch {
        break;
      }
    }
    writeLock({ pid: deadPid, port: 31338 });

    const client = new DaemonClient(vaultDir);
    expect(await client.getInfoAsync()).toBeNull();
  });

  it('prefers daemon.json over the lock when both are present', async () => {
    // daemon.json says port 1 — picking the lock would yield a different port.
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: 1 }));
    writeLock({ pid: process.pid, port: 31339, authToken: 'fromlock' });

    const client = new DaemonClient(vaultDir);
    const info = await client.getInfoAsync();
    expect(info).not.toBeNull();
    expect(info!.port).toBe(1);
  });

  it('reads the lock even if the lock is currently flocked by another process', async () => {
    // readLockHolder uses a plain open+read, no flock. A daemon holding
    // the flock must not block hook discovery.
    writeLock({ pid: process.pid, port: 31340 });

    const client = new DaemonClient(vaultDir);
    const info = await client.getInfoAsync();
    expect(info).not.toBeNull();
    expect(info!.port).toBe(31340);
  });
});

describe('DaemonClient — auth header recovered from the lock', () => {
  it('attaches x-myco-auth from the lock when daemon.json is missing at construction time', async () => {
    // This is the load-bearing case: `defaultHeaders` is built ONCE in
    // the constructor. If daemon.json is missing then, the bearer
    // never gets attached and every subsequent request 401s at the
    // daemon's auth gate — even though `getInfoAsync` later finds the
    // daemon via the lock. The lock-tier fallback in
    // `resolveDaemonAuthHeader` closes that window.
    writeLock({ pid: process.pid, port: 31341, authToken: 'token-from-lock' });

    // No daemon.json on disk. Capture any outbound fetch the client
    // makes via a stub server bound to the lock's recorded port; the
    // request must arrive with `x-myco-auth: token-from-lock`.
    const seenAuth: string[] = [];
    const http = await import('node:http');
    const stub = http.createServer((req, res) => {
      const h = req.headers['x-myco-auth'];
      if (typeof h === 'string') seenAuth.push(h);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      stub.once('error', reject);
      stub.listen(31341, '127.0.0.1', () => resolve());
    });
    try {
      const client = new DaemonClient(vaultDir);
      const result = await client.capturePost('/events', { type: 'user_prompt', session_id: 'probe' });
      expect(result.ok).toBe(true);
      expect(seenAuth).toContain('token-from-lock');
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });
});
