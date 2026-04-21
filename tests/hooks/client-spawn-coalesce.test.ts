import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DAEMON_SPAWN_COALESCE_MS } from '@myco/constants';

// Mock child_process.spawn at module-boundary so the `spawn` import inside
// hooks/client.ts resolves to our spy. vi.spyOn doesn't work here — the
// named import captures the real function at parse time.
const spawnMock = vi.fn(() => ({ unref: () => {} }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

// Late import so the mock is in place before client.ts evaluates.
const { DaemonClient } = await import('@myco/hooks/client');

// Exercises the coalesce guard that stops a burst of concurrent hook/MCP
// spawns from forking multiple daemon processes. The guard fires only when
// daemon.json is recent AND its pid is alive — stale or orphaned daemon.json
// must still trigger a real spawn.
describe('DaemonClient.spawnDaemon — coalesce guard', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spawn-coalesce-'));
    spawnMock.mockClear();
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function writeDaemonJson(pid: number): void {
    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
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
    const jsonPath = path.join(vaultDir, 'daemon.json');
    const ancientSec = (Date.now() - DAEMON_SPAWN_COALESCE_MS - 1_000) / 1_000;
    fs.utimesSync(jsonPath, ancientSec, ancientSec);
    new DaemonClient(vaultDir).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});
