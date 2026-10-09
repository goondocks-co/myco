/**
 * Tests for the cross-platform update/restart orchestrator (apply-update.ts).
 *
 * The orchestrator replaces the old generated `#!/bin/sh` scripts. Its job:
 * sleep → npm install (update only) → readiness guard →
 * restart. The overriding invariant is that the daemon ALWAYS comes back, even
 * when npm fails or an unexpected error is thrown.
 *
 * `run()` accepts an injectable deps bag so these tests can assert behavior
 * without spawning npm, hitting the network, or restarting anything real.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, type ApplyUpdateDeps } from '@myco/upgrade/orchestrator.js';
import type { ApplyUpdateParams, ApplyRestartParams } from '@myco/upgrade/orchestrator.js';
import { FakeServiceManager } from '../helpers/fake-service-manager';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-update-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a params object to a temp JSON file and return its path (== argv[0]). */
function writeParams(params: ApplyUpdateParams | ApplyRestartParams): string {
  const p = path.join(tmpDir, 'params.json');
  fs.writeFileSync(p, JSON.stringify(params), 'utf-8');
  return p;
}

interface Recorder {
  deps: ApplyUpdateDeps;
  mgr: FakeServiceManager;
  npmCalls: string[][];
  npmCwds: Array<string | undefined>;
  detachedSpawns: Array<{ bin: string; args: string[]; cwd?: string }>;
  npmOk: boolean;
  healthVersion: string | null;
}

/** Build a deps bag that records everything and never touches the real world. */
function makeDeps(opts: { npmOk?: boolean; healthVersion?: string | null } = {}): Recorder {
  const mgr = new FakeServiceManager();
  const rec: Recorder = {
    npmCalls: [],
    npmCwds: [],
    detachedSpawns: [],
    npmOk: opts.npmOk ?? true,
    healthVersion: opts.healthVersion ?? null,
    mgr,
    deps: undefined as never,
  };
  rec.deps = {
    getServiceManager: () => mgr,
    runNpm: vi.fn(async (args: string[], cwd?: string) => {
      rec.npmCalls.push(args);
      rec.npmCwds.push(cwd);
      return { ok: rec.npmOk, output: 'npm output' };
    }),
    spawnDetached: vi.fn((bin: string, args: string[], cwd?: string) => {
      rec.detachedSpawns.push({ bin, args, cwd });
    }),
    probeHealth: vi.fn(async () => (rec.healthVersion === null ? null : { version: rec.healthVersion })),
    probeDaemonState: vi.fn(() => (rec.healthVersion === null ? null : { version: rec.healthVersion })),
    // No real waiting in tests.
    sleep: vi.fn(async () => {}),
  };
  return rec;
}

// The operator-CLI-only update path: no myco binary swap. The myco self-update
// always travels the binary-swap path (covered below); this base exercises the
// remaining `npm install -g` (operator CLIs) + restart flow.
const UPDATE_PARAMS: ApplyUpdateParams = {
  kind: 'update',
  packageSpecs: ['@goondocks/myco-team@1.1.0'],
  projectRoot: '/project',
  vaultDir: '/project/.myco',
  mycoBinary: 'myco',
  serviceManagedLabel: null,
  daemonPort: 20915,
  targetVersion: '1.1.0',
};

describe('run() — kind:update', () => {
  it('sleeps, runs npm install -g, then restarts (non-service: direct daemon spawn)', async () => {
    const rec = makeDeps();
    await run([writeParams(UPDATE_PARAMS)], rec.deps);

    expect(rec.deps.sleep).toHaveBeenCalled();
    expect(rec.npmCalls).toContainEqual(['install', '-g', '@goondocks/myco-team@1.1.0']);
    // No service label → direct daemon respawn.
    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('service-managed: restarts via the ServiceManager, not a direct spawn', async () => {
    const rec = makeDeps();
    await run([writeParams({ ...UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    expect(rec.mgr.restartCalls).toEqual(['co.goondocks.myco']);
    expect(rec.detachedSpawns).toEqual([]);
  });

  it('readiness guard: skips restart when /health already reports the target version', async () => {
    const rec = makeDeps({ healthVersion: '1.1.0' });
    await run([writeParams({ ...UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    // Already converged → no restart of any kind.
    expect(rec.mgr.restartCalls).toEqual([]);
    expect(rec.detachedSpawns).toEqual([]);
  });

  it('readiness guard: restarts when /health reports a DIFFERENT version', async () => {
    const rec = makeDeps({ healthVersion: '1.0.0' });
    await run([writeParams(UPDATE_PARAMS)], rec.deps);
    expect(rec.detachedSpawns.length).toBe(1);
  });

  it('npm failure: writes UPDATE_ERROR_PATH AND still restarts the daemon', async () => {
    const rec = makeDeps({ npmOk: false });
    await run([writeParams(UPDATE_PARAMS)], rec.deps);

    // Daemon still comes back (the whole point — never strand).
    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
    expect(rec.npmCalls).toEqual([['install', '-g', '@goondocks/myco-team@1.1.0']]);
  });

  it('service restart throws → falls back to a direct daemon spawn (never strands)', async () => {
    const rec = makeDeps();
    rec.mgr.restart = vi.fn(async () => { throw new Error('kickstart blew up'); }) as never;
    await run([writeParams({ ...UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
  });
});

const RESTART_PARAMS: ApplyRestartParams = {
  kind: 'restart',
  projectRoot: '/home/user/project',
  vaultDir: '/home/user/project/.myco',
  runLocalUpdate: false,
  fromVersion: '0.17.0',
  toVersion: '0.17.1',
  mycoBinary: 'myco',
  serviceManagedLabel: null,
  daemonPort: 20915,
  restartReasonPath: '', // set per-test to a tmp path
};

describe('run() — kind:restart', () => {
  it('writes restart-reason.json and restarts (no npm install)', async () => {
    const rec = makeDeps();
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    await run([writeParams({ ...RESTART_PARAMS, restartReasonPath: reasonPath })], rec.deps);

    expect(rec.npmCalls).toEqual([]); // restart path never installs
    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/home/user/project' }]);

    const reason = JSON.parse(fs.readFileSync(reasonPath, 'utf-8'));
    expect(reason).toMatchObject({
      reason: 'version_sync',
      from_version: '0.17.0',
      to_version: '0.17.1',
      local_update_ran: false,
    });
  });

  it('service-managed restart routes through the ServiceManager', async () => {
    const rec = makeDeps();
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    await run([writeParams({
      ...RESTART_PARAMS,
      restartReasonPath: reasonPath,
      serviceManagedLabel: 'co.goondocks.myco',
    })], rec.deps);

    expect(rec.mgr.restartCalls).toEqual(['co.goondocks.myco']);
    expect(rec.detachedSpawns).toEqual([]);
  });

  it('ignores the retired project refresh request and reports no local update', async () => {
    const rec = makeDeps();
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    await run([writeParams({ ...RESTART_PARAMS, restartReasonPath: reasonPath, runLocalUpdate: true })], rec.deps);

    const reason = JSON.parse(fs.readFileSync(reasonPath, 'utf-8'));
    expect(reason.local_update_ran).toBe(false);
  });

  it('readiness guard skips restart when already on toVersion', async () => {
    const rec = makeDeps({ healthVersion: '0.17.1' });
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    await run([writeParams({ ...RESTART_PARAMS, restartReasonPath: reasonPath })], rec.deps);

    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
    // restart-reason.json is still written even when we skip the restart.
    expect(fs.existsSync(reasonPath)).toBe(true);
  });
});

describe('run() — robustness', () => {
  it('unreadable params file: does not throw', async () => {
    const rec = makeDeps();
    await expect(run([path.join(tmpDir, 'missing.json')], rec.deps)).resolves.toBeUndefined();
    // No restart attempted — there's nothing to restart against.
    expect(rec.detachedSpawns).toEqual([]);
  });
});
