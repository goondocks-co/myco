import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_SPAWN_COALESCE_MS } from '@myco/constants';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import * as childProcessActual__ns from 'node:child_process';

// Mock child_process.spawn at module-boundary so the `spawn` import inside
// hooks/client.ts resolves to our spy. vi.spyOn doesn't work here — the
// named import captures the real function at parse time.
const spawnMock = vi.fn(() => ({ unref: () => {} }));
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({ ...childProcessActual, spawn: spawnMock }));

// Late import so the mock is in place before client.ts evaluates.
const { DaemonClient } = await import('@myco/hooks/client');

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
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeDaemonJson(pid: number): void {
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid, port: 21039 }),
    );
  }

  it('spawns when daemon.json is absent', () => {
    new DaemonClient(vaultDir).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('defers spawn when daemon.json is recent AND its pid is alive', () => {
    // process.pid is always alive from its own perspective, so it's a stable
    // stand-in for an in-flight spawner's pid.
    writeDaemonJson(process.pid);
    new DaemonClient(vaultDir).spawnDaemon();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still spawns when daemon.json is recent but its pid is dead', () => {
    // Reserved pid value above any OS allocation range.
    const deadPid = 0x7fffffff;
    writeDaemonJson(deadPid);
    new DaemonClient(vaultDir).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('still spawns when daemon.json is older than the coalesce window', () => {
    writeDaemonJson(process.pid);
    const ancientSec = (Date.now() - DAEMON_SPAWN_COALESCE_MS - 1_000) / 1_000;
    fs.utimesSync(statePath, ancientSec, ancientSec);
    new DaemonClient(vaultDir).spawnDaemon();
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
      const client = new DaemonClient(vaultDir);
      const result = await call(client);
      expect(result.ok).toBe(false);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  });

  it('post spawns after fetch failure to a stale daemon.json pointing at a dead port', async () => {
    // Reserved pid + unbound high port so fetch throws ECONNREFUSED.
    fs.writeFileSync(
      statePath,
      JSON.stringify({ pid: 0x7fffffff, port: 1 }),
    );
    const client = new DaemonClient(vaultDir);
    const result = await client.post('/x', {});
    expect(result.ok).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
