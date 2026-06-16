/**
 * Tests for the cross-platform update/restart orchestrator (apply-update.ts).
 *
 * The orchestrator replaces the old generated `#!/bin/sh` scripts. Its job:
 * sleep → npm install (update only) → project fan-out → readiness guard →
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

import { run, type ApplyUpdateDeps } from '@myco/daemon/apply-update.js';
import type { ApplyUpdateParams, ApplyRestartParams } from '@myco/daemon/apply-update.js';
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
  fanoutCalls: Array<{ bin: string; logPath: string }>;
  npmOk: boolean;
  healthVersion: string | null;
}

/** Build a deps bag that records everything and never touches the real world. */
function makeDeps(opts: { npmOk?: boolean; healthVersion?: string | null; createRuntimeOnInstall?: boolean } = {}): Recorder {
  const mgr = new FakeServiceManager();
  const rec: Recorder = {
    npmCalls: [],
    npmCwds: [],
    detachedSpawns: [],
    fanoutCalls: [],
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
      // Simulate a successful managed-runtime install populating the staging
      // dir (`--prefix <basename>` resolved against `cwd`) so the atomic rename
      // can succeed — the real npm creates it; the mock otherwise wouldn't.
      const prefixIdx = args.indexOf('--prefix');
      if (opts.createRuntimeOnInstall && rec.npmOk && prefixIdx >= 0 && cwd) {
        fs.mkdirSync(path.join(cwd, args[prefixIdx + 1]), { recursive: true });
      }
      return { ok: rec.npmOk, output: 'npm output' };
    }),
    spawnDetached: vi.fn((bin: string, args: string[], cwd?: string) => {
      rec.detachedSpawns.push({ bin, args, cwd });
    }),
    runFanout: vi.fn(async (bin: string, logPath: string) => {
      rec.fanoutCalls.push({ bin, logPath });
    }),
    probeHealth: vi.fn(async () => (rec.healthVersion === null ? null : { version: rec.healthVersion })),
    // No real waiting in tests.
    sleep: vi.fn(async () => {}),
  };
  return rec;
}

const UPDATE_PARAMS: ApplyUpdateParams = {
  kind: 'update',
  packageSpecs: ['@goondocks/myco@1.1.0'],
  projectRoot: '/project',
  vaultDir: '/project/.myco',
  mycoBinary: 'myco',
  serviceManagedLabel: null,
  daemonPort: 20915,
  targetVersion: '1.1.0',
  machineRuntimeDir: '/tmp/does-not-exist/runtime',
  machineRuntimeTmpDir: '/tmp/does-not-exist/runtime.tmp',
  machineRuntimeCommandPath: '/tmp/does-not-exist/runtime.command',
  machineRuntimeMyco: '/tmp/does-not-exist/runtime/node_modules/.bin/myco',
};

describe('run() — kind:update', () => {
  it('sleeps, runs npm install -g, then restarts (non-service: direct daemon spawn)', async () => {
    const rec = makeDeps();
    await run([writeParams(UPDATE_PARAMS)], rec.deps);

    expect(rec.deps.sleep).toHaveBeenCalled();
    expect(rec.npmCalls).toContainEqual(['install', '-g', '@goondocks/myco@1.1.0']);
    // Successful install fans the per-project sync out before restarting.
    expect(rec.fanoutCalls.length).toBe(1);
    expect(rec.fanoutCalls[0].bin).toBe('myco');
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
    // On failure the per-project fan-out is skipped (the install never landed).
    expect(rec.fanoutCalls).toEqual([]);
    expect(rec.npmCalls).toEqual([['install', '-g', '@goondocks/myco@1.1.0']]);
  });

  it('service restart throws → falls back to a direct daemon spawn (never strands)', async () => {
    const rec = makeDeps();
    rec.mgr.restart = vi.fn(async () => { throw new Error('kickstart blew up'); }) as never;
    await run([writeParams({ ...UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
  });

  it('beta managed-runtime install: --prefix is a space-free basename run in the parent cwd (space-safe)', async () => {
    // B1: a spaced MYCO_HOME must NOT be passed as a `--prefix <full path>` arg
    // — the shell npm runs under word-splits it. The prefix is the basename and
    // the spaced parent rides in `cwd` (an OS-level arg the shell never splits).
    const rec = makeDeps({ createRuntimeOnInstall: true });
    const spacedHome = path.join(tmpDir, 'My Myco Home');
    const runtimeTmp = path.join(spacedHome, 'runtime.tmp');
    const runtimeDir = path.join(spacedHome, 'runtime');
    const managedMyco = path.join(runtimeDir, 'node_modules', '.bin', 'myco');

    await run([writeParams({
      ...UPDATE_PARAMS,
      packageSpecs: [],
      localRuntimeSpec: '@goondocks/myco@1.1.0-beta.1',
      machineRuntimeDir: runtimeDir,
      machineRuntimeTmpDir: runtimeTmp,
      machineRuntimeCommandPath: path.join(spacedHome, 'runtime.command'),
      machineRuntimeMyco: managedMyco,
    })], rec.deps);

    expect(rec.npmCalls[0]).toEqual(['install', '--prefix', 'runtime.tmp', '@goondocks/myco@1.1.0-beta.1']);
    expect(rec.npmCwds[0]).toBe(spacedHome);
    // Rename succeeded → the managed binary is adopted for the restart.
    expect(rec.detachedSpawns).toEqual([{ bin: managedMyco, args: ['daemon'], cwd: '/project' }]);
  });

  it('beta managed-runtime swap failure: falls back to the original binary and still restarts (no silent strand)', async () => {
    // B2: if the atomic rename throws (here: staging dir never created, as if
    // npm produced nothing), we must NOT pin/adopt a binary in a directory that
    // does not exist. Fall back to the original binary and still come back.
    const rec = makeDeps();
    const spacedHome = path.join(tmpDir, 'My Myco Home');
    const runtimeDir = path.join(spacedHome, 'runtime');
    const managedMyco = path.join(runtimeDir, 'node_modules', '.bin', 'myco');

    await run([writeParams({
      ...UPDATE_PARAMS,
      packageSpecs: [],
      localRuntimeSpec: '@goondocks/myco@1.1.0-beta.1',
      machineRuntimeDir: runtimeDir,
      machineRuntimeTmpDir: path.join(spacedHome, 'runtime.tmp'), // never created → rename ENOENTs
      machineRuntimeCommandPath: path.join(spacedHome, 'runtime.command'),
      machineRuntimeMyco: managedMyco,
    })], rec.deps);

    // Daemon comes back on the ORIGINAL binary, never the missing managed one.
    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
    // The pin to the non-existent managed binary was NOT written.
    expect(fs.existsSync(path.join(spacedHome, 'runtime.command'))).toBe(false);
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
    expect(rec.fanoutCalls).toEqual([]); // runLocalUpdate:false → no fan-out
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

  it('runLocalUpdate:true fans the per-project sync out before restarting', async () => {
    const rec = makeDeps();
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    await run([writeParams({ ...RESTART_PARAMS, restartReasonPath: reasonPath, runLocalUpdate: true })], rec.deps);

    expect(rec.fanoutCalls.length).toBe(1);
    expect(rec.fanoutCalls[0].bin).toBe('myco');
    const reason = JSON.parse(fs.readFileSync(reasonPath, 'utf-8'));
    expect(reason.local_update_ran).toBe(true);
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
