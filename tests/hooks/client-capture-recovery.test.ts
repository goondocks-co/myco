/**
 * DaemonClient capture-critical recovery — liveness probe before restart.
 *
 * A failed capture POST used to restart the owning service unconditionally
 * (after the 30s coalesce marker). Two healthy-daemon shapes reach that
 * path: a daemon.json briefly carrying a foreign pid/port (clobbered by
 * another process; the daemon's self-reconciler heals it within a tick),
 * and an event-loop stall longer than the capture request timeout. The
 * client must confirm the daemon is unreachable on every discovery tier
 * before it asks the supervisor to restart a production daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient } from '@myco/hooks/client';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import {
  resolveMycoHome,
  resolveServiceDaemonStatePath,
  resolveServiceDir,
} from '@myco/grove/paths';
import { listenEphemeral, closeServer } from '../helpers/net.js';
import { FakeServiceManager } from '../helpers/fake-service-manager.js';

let vaultDir: string;
let mycoHome: string;
let serviceDir: string;
let lockPath: string;
let statePath: string;
let markerPath: string;
let previousHome: string | undefined;
let previousNoAutoSpawn: string | undefined;

beforeEach(() => {
  previousHome = process.env.MYCO_HOME;
  previousNoAutoSpawn = process.env.MYCO_NO_AUTO_SPAWN;
  process.env.MYCO_NO_AUTO_SPAWN = '1';
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-recovery-'));
  mycoHome = path.join(vaultDir, 'home');
  fs.mkdirSync(mycoHome, { recursive: true });
  process.env.MYCO_HOME = mycoHome;
  ensureProjectManifest(vaultDir, { projectName: 'capture-recovery-test' });
  serviceDir = resolveServiceDir(resolveMycoHome());
  fs.mkdirSync(serviceDir, { recursive: true });
  lockPath = path.join(serviceDir, 'daemon.lock');
  statePath = resolveServiceDaemonStatePath(mycoHome);
  markerPath = path.join(serviceDir, 'capture-recovery.json');
});

afterEach(() => {
  fs.rmSync(vaultDir, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = previousHome;
  if (previousNoAutoSpawn === undefined) delete process.env.MYCO_NO_AUTO_SPAWN;
  else process.env.MYCO_NO_AUTO_SPAWN = previousNoAutoSpawn;
});

// Port 1 is never listening — connects fail with an immediate refusal, the
// same shape a hook sees when daemon.json carries a foreign port.
function writePoisonedState(): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: 1 }));
}

function writeLock(holder: { pid: number; port: number }): void {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      pid: holder.pid,
      startedAt: Math.floor(Date.now() / 1000),
      command: 'mock daemon',
      port: holder.port,
    }, null, 2) + '\n',
  );
}

describe('DaemonClient capture-critical recovery', () => {
  it('does not restart the service when the daemon is reachable via the lock tier', async () => {
    const { server, port } = await listenEphemeral((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true, pid: process.pid }));
    });
    try {
      writePoisonedState();
      writeLock({ pid: process.pid, port });

      const mgr = new FakeServiceManager({ preInstalled: true });
      const client = new DaemonClient(vaultDir, { serviceManager: mgr });
      const result = await client.capturePost('/events', { type: 'user_prompt', session_id: 's' });

      // The poisoned port made the request itself fail...
      expect(result.ok).toBe(false);
      // ...but the daemon answered the liveness probe, so no restart and
      // no recovery marker.
      expect(mgr.restartCalls).toEqual([]);
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('restarts the installed service once every probe confirms the daemon is unreachable, coalescing repeats', async () => {
    writePoisonedState();
    // No lock, nothing on the canonical port: the daemon is genuinely gone.

    const mgr = new FakeServiceManager({ preInstalled: true });
    const client = new DaemonClient(vaultDir, { serviceManager: mgr });

    const first = await client.capturePost('/events', { type: 'user_prompt', session_id: 's' });
    expect(first.ok).toBe(false);
    expect(mgr.restartCalls.length).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(true);

    // A second failure inside the coalesce window must not restart again.
    const second = await client.capturePost('/events', { type: 'user_prompt', session_id: 's' });
    expect(second.ok).toBe(false);
    expect(mgr.restartCalls.length).toBe(1);
  }, 20_000);
});
