import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_SPAWN_COALESCE_MS } from '@myco/constants';
import { resolveServiceDaemonStatePath, setDevServiceMode } from '@myco/grove/paths';
import * as childProcessActual__ns from 'node:child_process';
import { FakeServiceManager, noServiceManager } from '../helpers/fake-service-manager';

// Mock child_process.spawn at module-boundary so the `spawn` import inside
// hooks/client.ts resolves to our spy. vi.spyOn doesn't work here — the
// named import captures the real function at parse time.
const spawnMock = vi.fn(() => ({ unref: () => {} }));
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({ ...childProcessActual, spawn: spawnMock }));

// bun:test's mock.module() is process-scoped. Without an explicit restore,
// the spawn spy leaks into every later test file that imports node:child_process
// in the same `bun test` invocation (the canonical runner uses --isolate, but
// the restore stays correct under any caller). Restore the real module after
// this file finishes.
afterAll(() => {
  mock.module('node:child_process', () => childProcessActual);
});

// Late import so the mock is in place before client.ts evaluates.
const { DaemonClient } = await import('@myco/hooks/client');

// The coalesce tests below use `noServiceManager()` to take the legacy
// (no-service) spawn path regardless of whether the host has the real
// launchd/systemd unit installed. The dedicated service-aware suite at the
// bottom uses `FakeServiceManager` directly to drive the deferral logic.

// Exercises the coalesce guard that stops a burst of concurrent hook/MCP
// spawns from forking multiple daemon processes. The guard fires only when
// daemon.json is recent AND its pid is alive — stale or orphaned daemon.json
// must still trigger a real spawn.
describe('DaemonClient.spawnDaemon — coalesce guard', () => {
  let vaultDir: string;
  let statePath: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spawn-coalesce-'));
    statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    spawnMock.mockClear();
  });

  afterEach(() => {
    setDevServiceMode(false);
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeDaemonJson(pid: number): void {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid, port: 21039 }),
    );
  }

  it('spawns when daemon.json is absent', async () => {
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('defers spawn when daemon.json is recent AND its pid is alive', async () => {
    // process.pid is always alive from its own perspective, so it's a stable
    // stand-in for an in-flight spawner's pid.
    writeDaemonJson(process.pid);
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still spawns when daemon.json is recent but its pid is dead', async () => {
    // Reserved pid value above any OS allocation range.
    const deadPid = 0x7fffffff;
    writeDaemonJson(deadPid);
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('still spawns when daemon.json is older than the coalesce window', async () => {
    writeDaemonJson(process.pid);
    const ancientSec = (Date.now() - DAEMON_SPAWN_COALESCE_MS - 1_000) / 1_000;
    fs.utimesSync(statePath, ancientSec, ancientSec);
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// Every request method auto-spawns the daemon when it's unreachable, so any
// hook activity — not just session-start — resurrects a dead daemon after a
// reboot. The coalesce guard still dedupes per 3s window.
describe('DaemonClient — auto-spawn on request failure', () => {
  let vaultDir: string;
  let statePath: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-auto-spawn-'));
    statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    spawnMock.mockClear();
  });

  afterEach(() => {
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('post/get/put/delete each spawn when daemon.json is missing', async () => {
    for (const call of [
      (c: InstanceType<typeof DaemonClient>) => c.post('/x', {}),
      (c: InstanceType<typeof DaemonClient>) => c.get('/x'),
      (c: InstanceType<typeof DaemonClient>) => c.put('/x', {}),
      (c: InstanceType<typeof DaemonClient>) => c.delete('/x'),
    ]) {
      spawnMock.mockClear();
      const client = new DaemonClient(vaultDir, { serviceManager: noServiceManager() });
      const result = await call(client);
      expect(result.ok).toBe(false);
      // spawnDaemon is fire-and-forget from the request method; flush
      // pending microtasks so its async service-detection path runs.
      await new Promise((r) => setImmediate(r));
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  });

  it('post spawns after fetch failure to a stale daemon.json pointing at a dead port', async () => {
    // Reserved pid + unbound high port so fetch throws ECONNREFUSED.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid: 0x7fffffff, port: 1 }),
    );
    const client = new DaemonClient(vaultDir, { serviceManager: noServiceManager() });
    const result = await client.post('/x', {});
    expect(result.ok).toBe(false);
    await new Promise((r) => setImmediate(r));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

// When a service supervisor (launchd/systemd) owns the daemon, raw spawns
// from DaemonClient race the supervisor for port ownership and trigger
// thundering-herd SIGTERMs via the sibling-stepping-aside path. spawnDaemon
// must defer to the supervisor in that case — start it if cold, otherwise
// no-op and let the next probe succeed.
describe('DaemonClient.spawnDaemon — service-aware deferral', () => {
  let vaultDir: string;
  let statePath: string;

  beforeEach(() => {
    setDevServiceMode(false);
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-svc-defer-'));
    statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    spawnMock.mockClear();
  });

  afterEach(() => {
    setDevServiceMode(false);
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('no service installed: legacy raw spawn happens', async () => {
    const mgr = new FakeServiceManager();
    // installed is empty
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(mgr.startCalls).toEqual([]);
  });

  it('service installed AND running: no raw spawn, no start call', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', {
      installed: true, running: true, pid: 4242, lastExitCode: null, unitPath: '/x.plist',
    });
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mgr.startCalls).toEqual([]);
  });

  it('service installed but NOT running: calls mgr.start(label), no raw spawn', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', {
      installed: true, running: false, pid: null, lastExitCode: 0, unitPath: '/x.plist',
    });
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mgr.startCalls).toEqual(['co.goondocks.myco']);
  });

  it('dev variant installed and not running: starts the dev label', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco-dev');
    mgr.statuses.set('co.goondocks.myco-dev', {
      installed: true, running: false, pid: null, lastExitCode: null, unitPath: '/x.plist',
    });
    setDevServiceMode(true);
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mgr.startCalls).toEqual(['co.goondocks.myco-dev']);
  });

  it('prod client ignores installed dev service and starts prod service', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco-dev');
    mgr.statuses.set('co.goondocks.myco-dev', {
      installed: true, running: true, pid: 1111, lastExitCode: 0, unitPath: '/dev.plist',
    });
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', {
      installed: true, running: false, pid: null, lastExitCode: 78, unitPath: '/prod.plist',
    });
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(mgr.startCalls).toEqual(['co.goondocks.myco']);
  });

  it('unsupported platform: falls back to legacy raw spawn', async () => {
    const mgr = new FakeServiceManager({ supported: false });
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(mgr.startCalls).toEqual([]);
  });

  it('mgr.start() failure does not propagate (best-effort)', async () => {
    class ThrowingStart extends FakeServiceManager {
      override async start(_label: string): Promise<void> { throw new Error('boom'); }
    }
    const mgr = new ThrowingStart();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', {
      installed: true, running: false, pid: null, lastExitCode: null, unitPath: null,
    });
    // Must not throw.
    await new DaemonClient(vaultDir, { serviceManager: mgr }).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
