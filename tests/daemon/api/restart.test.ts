import { afterAll, afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Stub spawn before importing the handler.
type SpawnCall = { cmd: string; args: string[]; opts: unknown };
const spawnCalls: SpawnCall[] = [];
import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
  ...childProcessActual,
  spawn: vi.fn((cmd: string, args: string[], opts: unknown) => {
    spawnCalls.push({ cmd, args, opts });
    return { unref: () => {}, on: () => {}, kill: () => {} } as any;
  }),
}));

// bun:test's mock.module() is process-scoped — restore the real module after
// this file so later files in the same `bun test` run see a real spawn().
afterAll(() => {
  mock.module('node:child_process', () => childProcessActual);
});

// Restart handler triggers a `setTimeout(... process.kill, ...)`. Stub kill so
// the test process is never SIGTERMed by its own units.
const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
const realKill = process.kill;
function stubProcessKill() {
  (process as any).kill = (pid: number, signal: NodeJS.Signals | number) => {
    killCalls.push({ pid, signal });
  };
}
function restoreProcessKill() {
  (process as any).kill = realKill;
}

import { buildRestartArgv, detectServiceManagedLabel, findInstalledServiceLabel, handleRestart, type RestartHandlerDeps } from '@myco/daemon/api/restart.js';
import { ProgressTracker } from '@myco/daemon/api/progress.js';
import { serviceLabel } from '@myco/service/labels.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { FakeServiceManager } from '../../helpers/fake-service-manager';

// The test runner sets a hermetic sandbox MYCO_HOME, so the daemon's service
// label is the home-derived label for that sandbox — NOT the canonical
// `co.goondocks.myco`. Resolve it the same way the production code does so the
// seeded fake matches what findInstalledServiceLabel(mgr) looks up.
const HOME_LABEL = serviceLabel(resolveMycoHome());

function makeDeps(overrides: Partial<RestartHandlerDeps> = {}): RestartHandlerDeps {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-vault-'));
  return {
    vaultDir,
    progressTracker: new ProgressTracker(),
    ...overrides,
  };
}

describe('buildRestartArgv (shell-free, cross-platform)', () => {
  test('non-service-managed: respawns the daemon directly', () => {
    expect(buildRestartArgv(null, null)).toEqual(['daemon']);
  });

  test('non-service-managed with cliEntry: prepends the entry path', () => {
    expect(buildRestartArgv(null, '/dist/cli.js')).toEqual(['/dist/cli.js', 'daemon']);
  });

  test('service-managed: `service restart` (no variant flag — the child inherits MYCO_HOME)', () => {
    expect(buildRestartArgv('co.goondocks.myco', null)).toEqual(['service', 'restart']);
  });

  test('service-managed for any home label: still just `service restart`', () => {
    expect(buildRestartArgv('co.goondocks.myco.0be20de4', null)).toEqual(['service', 'restart']);
  });
});

// Process-agnostic sibling of detectServiceManagedLabel — used by client-side
// surfaces (DaemonClient.spawnDaemon) that need to know "is a supervisor
// installed for this home" without checking the PID match. There is exactly
// one managed service per home now (its label IS the home), so the default
// resolves `serviceLabel(resolveMycoHome())`; the test env's default home is
// `~/.myco` → `co.goondocks.myco`.
describe('findInstalledServiceLabel', () => {
  test('returns null when service manager is unsupported', async () => {
    const mgr = new FakeServiceManager({ supported: false });
    expect(await findInstalledServiceLabel(mgr)).toBeNull();
  });

  test('returns null when nothing is installed', async () => {
    const mgr = new FakeServiceManager();
    expect(await findInstalledServiceLabel(mgr)).toBeNull();
  });

  test('returns label + status when the home service is installed (running)', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    mgr.statuses.set(HOME_LABEL, { installed: true, running: true, pid: 4242, lastExitCode: 0, unitPath: '/x.plist' });
    const found = await findInstalledServiceLabel(mgr);
    expect(found?.label).toBe(HOME_LABEL);
    expect(found?.status.running).toBe(true);
    expect(found?.status.pid).toBe(4242);
  });

  test('returns label + not-running status when the service is installed but stopped', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    mgr.statuses.set(HOME_LABEL, { installed: true, running: false, pid: null, lastExitCode: 1, unitPath: '/x.plist' });
    const found = await findInstalledServiceLabel(mgr);
    expect(found?.label).toBe(HOME_LABEL);
    expect(found?.status.running).toBe(false);
  });

  test('does NOT require PID match (process-agnostic)', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    // PID intentionally different from process.pid — findInstalledServiceLabel
    // must still return the entry; only detectServiceManagedLabel checks PID.
    mgr.statuses.set(HOME_LABEL, { installed: true, running: true, pid: process.pid + 999, lastExitCode: 0, unitPath: '/x.plist' });
    const found = await findInstalledServiceLabel(mgr);
    expect(found?.label).toBe(HOME_LABEL);
  });

  test('an explicit home selects that home\'s label', async () => {
    const home = path.join(os.homedir(), '.myco-other');
    const label = serviceLabel(home);
    const mgr = new FakeServiceManager();
    mgr.installed.add(label);
    mgr.statuses.set(label, { installed: true, running: true, pid: 1111, lastExitCode: 0, unitPath: '/other.plist' });
    const found = await findInstalledServiceLabel(mgr, home);
    expect(found?.label).toBe(label);
  });

  test('detectServiceManagedLabel matches the home service by PID', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    mgr.statuses.set(HOME_LABEL, { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/prod.plist' });
    await expect(detectServiceManagedLabel(mgr, process.pid)).resolves.toBe(HOME_LABEL);
  });
});

describe('handleRestart', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    killCalls.length = 0;
    stubProcessKill();
  });

  afterEach(() => {
    restoreProcessKill();
  });

  test('non-service-managed: spawns `myco daemon` and schedules SIGTERM', async () => {
    const mgr = new FakeServiceManager();
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting' });
    expect(spawnCalls.length).toBe(1);
    const shellCmd = (spawnCalls[0].args ?? []).join(' '); // direct-spawn argv, joined
    expect(shellCmd).toContain('daemon');
    expect(shellCmd).not.toContain('service restart');
  });

  test('service-managed: routes to `service restart` (no variant flag — child inherits MYCO_HOME)', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    mgr.statuses.set(HOME_LABEL, { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/x' });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting' });
    const shellCmd = (spawnCalls[0].args ?? []).join(' '); // direct-spawn argv, joined
    expect(shellCmd).toContain('service restart');
    expect(shellCmd).not.toContain('--dev');
  });

  test('service installed but a different PID is the running daemon: treats us as non-service-managed', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add(HOME_LABEL);
    mgr.statuses.set(HOME_LABEL, { installed: true, running: true, pid: process.pid + 999, lastExitCode: 0, unitPath: '/x' });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting' });
    const shellCmd = (spawnCalls[0].args ?? []).join(' '); // direct-spawn argv, joined
    expect(shellCmd).not.toContain('service restart');
  });

  test('unsupported service manager: takes the non-service path without crashing', async () => {
    const mgr = new FakeServiceManager({ supported: false });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting' });
    const shellCmd = (spawnCalls[0].args ?? []).join(' '); // direct-spawn argv, joined
    expect(shellCmd).not.toContain('service restart');
  });

  test('active operations + no force: returns 409 and does NOT spawn', async () => {
    const mgr = new FakeServiceManager();
    const tracker = new ProgressTracker();
    tracker.create('backup');
    const deps = makeDeps({ serviceManager: mgr, progressTracker: tracker });
    const res = await handleRestart(deps, {});
    expect(res.status).toBe(409);
    expect(spawnCalls.length).toBe(0);
  });

  test('force=true overrides active-operations guard', async () => {
    const mgr = new FakeServiceManager();
    const tracker = new ProgressTracker();
    tracker.create('backup');
    const deps = makeDeps({ serviceManager: mgr, progressTracker: tracker });
    const res = await handleRestart(deps, { force: true });
    expect(res.body).toMatchObject({ status: 'restarting' });
    expect(spawnCalls.length).toBe(1);
  });
});
