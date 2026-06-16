import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pin MYCO_HOME to an isolated temp dir BEFORE importing anything that resolves
// daemon state paths (mirrors client-spawn-coalesce.test.ts), so the raw-spawn
// path runs against a sandbox rather than the user's real ~/.myco/service.
const TEST_MYCO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spawn-detached-home-'));
const PRIOR_MYCO_HOME = process.env.MYCO_HOME;
process.env.MYCO_HOME = TEST_MYCO_HOME;

import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import * as childProcessActual__ns from 'node:child_process';
import { noServiceManager } from '../helpers/fake-service-manager';

// Capture the options the production raw-spawn passes, plus the child stub it
// wires up (so we can assert the ENOENT 'error' handler and unref()).
interface CapturedSpawn {
  file: string;
  args: string[];
  options: Record<string, unknown>;
}
const captured: CapturedSpawn[] = [];
let onErrorAttached = false;
let unrefCalled = false;

const spawnMock = vi.fn((file: string, args: string[], options: Record<string, unknown>) => {
  captured.push({ file, args, options });
  return {
    on: (event: string) => { if (event === 'error') onErrorAttached = true; },
    unref: () => { unrefCalled = true; },
  };
});

const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({ ...childProcessActual, spawn: spawnMock }));

afterAll(() => {
  mock.module('node:child_process', () => childProcessActual);
  if (PRIOR_MYCO_HOME === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = PRIOR_MYCO_HOME;
  fs.rmSync(TEST_MYCO_HOME, { recursive: true, force: true });
});

// Late imports so the mock is in place before client.ts evaluates.
const { DaemonClient, buildDaemonSpawnOptions } = await import('@myco/hooks/client');

// buildDaemonSpawnOptions is a pure builder: the detached+unref+ignore-stdio+
// windowsHide contract is verifiable without spawning a process.
describe('buildDaemonSpawnOptions', () => {
  it('is detached, ignores stdio, hides the Windows console, and sets cwd', () => {
    const opts = buildDaemonSpawnOptions('/some/project/root');
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe('/some/project/root');
  });

  it('inherits no parent handles beyond cwd (no stdio array tying it to the parent)', () => {
    const opts = buildDaemonSpawnOptions('/x');
    // 'ignore' (not 'inherit' and not a pipe array) => no inherited fds.
    expect(opts.stdio).toBe('ignore');
  });
});

// The non-service raw respawn must survive the hook process exiting on every
// platform: detached + unref + ignore-stdio + windowsHide, with the async
// ENOENT 'error' guard intact.
describe('DaemonClient.spawnDaemon — detached respawn options', () => {
  let vaultDir: string;
  let statePath: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spawn-detached-'));
    statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    captured.length = 0;
    onErrorAttached = false;
    unrefCalled = false;
    spawnMock.mockClear();
  });

  afterEach(() => {
    try { fs.unlinkSync(statePath); } catch { /* gone */ }
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('spawns the daemon detached, unref\'d, ignore-stdio, windowsHide', async () => {
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const opts = captured[0].options;
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
    expect(opts.cwd).toBe(path.dirname(vaultDir));
  });

  it('attaches the ENOENT \'error\' handler and unref()s the child', async () => {
    await new DaemonClient(vaultDir, { serviceManager: noServiceManager() }).spawnDaemon();
    expect(onErrorAttached).toBe(true);
    expect(unrefCalled).toBe(true);
  });
});
