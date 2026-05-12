import { afterEach, beforeEach, describe, expect, test, mock } from 'bun:test';
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

import { buildRestartShellCommand, handleRestart, type RestartHandlerDeps } from '@myco/daemon/api/restart.js';
import { ProgressTracker } from '@myco/daemon/api/progress.js';
import type { ServiceManager, ServiceStatus } from '@myco/service/types.js';

class FakeServiceManager implements ServiceManager {
  readonly supported: boolean;
  readonly platformName = 'fake';
  /** label → status snapshot returned by status(). */
  statuses = new Map<string, ServiceStatus>();
  installed = new Set<string>();
  restartCalls: string[] = [];

  constructor(opts: { supported?: boolean } = {}) {
    this.supported = opts.supported ?? true;
  }

  async isInstalled(label: string): Promise<boolean> { return this.installed.has(label); }
  async install(): Promise<void> {}
  async uninstall(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async restart(label: string): Promise<void> { this.restartCalls.push(label); }
  restartShellCommand(label: string): string { return `fake-restart ${label}`; }
  async status(label: string): Promise<ServiceStatus> {
    return this.statuses.get(label) ?? { installed: false, running: false, pid: null, lastExitCode: null, unitPath: null };
  }
}

function makeDeps(overrides: Partial<RestartHandlerDeps> = {}): RestartHandlerDeps {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-vault-'));
  return {
    vaultDir,
    progressTracker: new ProgressTracker(),
    ...overrides,
  };
}

describe('buildRestartShellCommand', () => {
  test('non-service-managed: spawns daemon directly with full sleep', () => {
    const cmd = buildRestartShellCommand(null, '/usr/bin/myco', null);
    expect(cmd).toBe('sleep 3 && /usr/bin/myco daemon');
  });

  test('non-service-managed with cliEntry: includes entry path', () => {
    const cmd = buildRestartShellCommand(null, '/usr/bin/node', '/dist/cli.js');
    expect(cmd).toBe('sleep 3 && /usr/bin/node /dist/cli.js daemon');
  });

  test('service-managed prod: invokes `service restart` with no variant flag', () => {
    const cmd = buildRestartShellCommand('co.goondocks.myco', '/usr/bin/myco', null);
    expect(cmd).toBe('sleep 0.5 && /usr/bin/myco service restart');
  });

  test('service-managed dev: invokes `service restart --dev`', () => {
    const cmd = buildRestartShellCommand('co.goondocks.myco-dev', '/usr/bin/myco', null);
    expect(cmd).toBe('sleep 0.5 && /usr/bin/myco service restart --dev');
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
    expect(res.body).toMatchObject({ status: 'restarting', serviceManaged: false });
    expect(spawnCalls.length).toBe(1);
    const shellCmd = (spawnCalls[0].args[1] ?? '');
    expect(shellCmd).toContain('daemon');
    expect(shellCmd).not.toContain('service restart');
  });

  test('service-managed prod: routes to `service restart` (no variant flag) and reports serviceManaged=true', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/x' });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting', serviceManaged: true, serviceLabel: 'co.goondocks.myco' });
    const shellCmd = (spawnCalls[0].args[1] ?? '');
    expect(shellCmd).toContain('service restart');
    expect(shellCmd).not.toContain('--dev');
  });

  test('service-managed dev: routes to `service restart --dev`', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco-dev');
    mgr.statuses.set('co.goondocks.myco-dev', { installed: true, running: true, pid: process.pid, lastExitCode: 0, unitPath: '/x' });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ status: 'restarting', serviceManaged: true, serviceLabel: 'co.goondocks.myco-dev' });
    const shellCmd = (spawnCalls[0].args[1] ?? '');
    expect(shellCmd).toContain('service restart --dev');
  });

  test('service installed but a different PID is the running daemon: treats us as non-service-managed', async () => {
    const mgr = new FakeServiceManager();
    mgr.installed.add('co.goondocks.myco');
    mgr.statuses.set('co.goondocks.myco', { installed: true, running: true, pid: process.pid + 999, lastExitCode: 0, unitPath: '/x' });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ serviceManaged: false });
    const shellCmd = (spawnCalls[0].args[1] ?? '');
    expect(shellCmd).not.toContain('service restart');
  });

  test('unsupported service manager: takes the non-service path without crashing', async () => {
    const mgr = new FakeServiceManager({ supported: false });
    const deps = makeDeps({ serviceManager: mgr });
    const res = await handleRestart(deps, {});
    expect(res.body).toMatchObject({ serviceManaged: false });
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
