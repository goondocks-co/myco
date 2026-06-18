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
  fanoutCalls: Array<{ bin: string; logPath: string }>;
  binaryUpdateCalls: Array<Record<string, unknown>>;
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
    fanoutCalls: [],
    binaryUpdateCalls: [],
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
    runFanout: vi.fn(async (bin: string, logPath: string) => {
      rec.fanoutCalls.push({ bin, logPath });
    }),
    probeHealth: vi.fn(async () => (rec.healthVersion === null ? null : { version: rec.healthVersion })),
    // No real waiting in tests.
    sleep: vi.fn(async () => {}),
    // Injected fake binary-update primitive: the myco binary path uses this
    // INSTEAD of npm. It is the sole restart owner, so the fake records its
    // params and (by not calling spawnDetached/restart) leaves the
    // detachedSpawns/restartCalls assertions clean.
    applyBinaryUpdate: vi.fn(async (params: Record<string, unknown>) => {
      rec.binaryUpdateCalls.push(params);
    }),
  };
  return rec;
}

// The operator-CLI-only update path: no myco binary swap. The myco self-update
// always travels the binary-swap path (covered below); this base exercises the
// remaining `npm install -g` (operator CLIs) + fan-out + restart flow.
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
    expect(rec.npmCalls).toEqual([['install', '-g', '@goondocks/myco-team@1.1.0']]);
  });

  it('service restart throws → falls back to a direct daemon spawn (never strands)', async () => {
    const rec = makeDeps();
    rec.mgr.restart = vi.fn(async () => { throw new Error('kickstart blew up'); }) as never;
    await run([writeParams({ ...UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    expect(rec.detachedSpawns).toEqual([{ bin: 'myco', args: ['daemon'], cwd: '/project' }]);
  });
});

// ---------------------------------------------------------------------------
// kind:update — myco BINARY self-update path (Task 9b)
//
// When `mycoBinaryUpdate` is populated, myco updates by binary swap through
// `applyBinaryUpdate` — NOT the myco npm install and NOT the managed-runtime
// install. `applyBinaryUpdate` OWNS the restart + crash-loop recovery, so
// runUpdate must NOT also run its own restart (exactly one restart owner).
// Operator-CLI npm specs in `packageSpecs` STILL `npm install -g`.
// ---------------------------------------------------------------------------

const MYCO_BINARY_UPDATE = {
  assetUrl: 'https://example.test/releases/myco-darwin-arm64',
  sha256sumsUrl: 'https://example.test/releases/SHA256SUMS',
  assetName: 'myco-darwin-arm64',
  targetVersion: '1.1.0',
};

const BINARY_UPDATE_PARAMS: ApplyUpdateParams = {
  ...UPDATE_PARAMS,
  // The myco npm spec is GONE from packageSpecs on the binary path.
  packageSpecs: [],
  mycoBinaryUpdate: MYCO_BINARY_UPDATE,
  managedBinaryPath: '/home/user/.myco/bin/myco',
  maxHealthAttempts: 10,
  healthIntervalMs: 2000,
};

describe('run() — kind:update, myco binary self-update', () => {
  it('routes the myco update through applyBinaryUpdate with the resolved refs; no myco npm, no own restart', async () => {
    const rec = makeDeps();
    await run([writeParams(BINARY_UPDATE_PARAMS)], rec.deps);

    // The binary primitive was invoked exactly once with the resolved refs +
    // the managed binary path + restart routing.
    expect(rec.binaryUpdateCalls.length).toBe(1);
    expect(rec.binaryUpdateCalls[0]).toMatchObject({
      assetUrl: MYCO_BINARY_UPDATE.assetUrl,
      sha256sumsUrl: MYCO_BINARY_UPDATE.sha256sumsUrl,
      assetName: MYCO_BINARY_UPDATE.assetName,
      targetVersion: '1.1.0',
      binaryPath: '/home/user/.myco/bin/myco',
      daemonPort: 20915,
      serviceManagedLabel: null,
      projectRoot: '/project',
      maxHealthAttempts: 10,
      healthIntervalMs: 2000,
    });

    // Myco did NOT go through npm.
    expect(rec.npmCalls).toEqual([]);
    // runUpdate did NOT run its own restart — the primitive owns it.
    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('still npm-installs operator-CLI specs (myco-team / myco-collective), then runs the binary swap', async () => {
    const rec = makeDeps();
    await run([writeParams({
      ...BINARY_UPDATE_PARAMS,
      packageSpecs: ['@goondocks/myco-team@0.1.1', '@goondocks/myco-collective@0.2.0'],
    })], rec.deps);

    // Operator CLIs STAY on npm.
    expect(rec.npmCalls).toEqual([
      ['install', '-g', '@goondocks/myco-team@0.1.1', '@goondocks/myco-collective@0.2.0'],
    ]);
    // The binary swap still happened (and is still the sole restart owner).
    expect(rec.binaryUpdateCalls.length).toBe(1);
    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('passes the service label through to applyBinaryUpdate when service-managed', async () => {
    const rec = makeDeps();
    await run([writeParams({ ...BINARY_UPDATE_PARAMS, serviceManagedLabel: 'co.goondocks.myco' })], rec.deps);

    expect(rec.binaryUpdateCalls[0]).toMatchObject({ serviceManagedLabel: 'co.goondocks.myco' });
    // The primitive owns the restart — runUpdate must not pre-empt it.
    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('fans the per-project sync out (on the current binary) before the binary swap', async () => {
    const rec = makeDeps();
    await run([writeParams(BINARY_UPDATE_PARAMS)], rec.deps);

    // Fan-out runs on the still-running binary (config regen is version-agnostic),
    // then the swap restarts onto the new one.
    expect(rec.fanoutCalls.length).toBe(1);
    expect(rec.fanoutCalls[0].bin).toBe('myco');
    expect(rec.binaryUpdateCalls.length).toBe(1);
  });

  it('operator-CLI npm failure still proceeds to the binary swap (daemon must come back)', async () => {
    const rec = makeDeps({ npmOk: false });
    await run([writeParams({
      ...BINARY_UPDATE_PARAMS,
      packageSpecs: ['@goondocks/myco-team@0.1.1'],
    })], rec.deps);

    // npm failed, but the myco binary self-update is independent and still runs.
    expect(rec.npmCalls).toEqual([['install', '-g', '@goondocks/myco-team@0.1.1']]);
    expect(rec.binaryUpdateCalls.length).toBe(1);
  });

  it('runNpm THROWS: binary swap still reached (structural non-fatal invariant)', async () => {
    // Verify that an unexpected throw from runNpm (not just a { ok: false }
    // return) cannot strand the binary swap. The try/catch in runBinaryUpdate
    // must swallow the throw and proceed to applyBinaryUpdate.
    const rec = makeDeps();
    rec.deps.runNpm = vi.fn(async () => { throw new Error('runNpm exploded'); });
    await run([writeParams({
      ...BINARY_UPDATE_PARAMS,
      packageSpecs: ['@goondocks/myco-team@0.1.1'],
    })], rec.deps);

    // Despite the throw, applyBinaryUpdate was still invoked.
    expect(rec.binaryUpdateCalls.length).toBe(1);
    // runUpdate's own restart is not invoked — the primitive owns it.
    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
  });

  it('runFanout THROWS: binary swap still reached (structural non-fatal invariant)', async () => {
    // Verify that an unexpected throw from runFanout cannot strand the binary
    // swap. The try/catch in runBinaryUpdate must swallow the throw and
    // proceed to applyBinaryUpdate.
    const rec = makeDeps();
    rec.deps.runFanout = vi.fn(async () => { throw new Error('runFanout exploded'); });
    await run([writeParams(BINARY_UPDATE_PARAMS)], rec.deps);

    // Fan-out threw, but applyBinaryUpdate was still invoked.
    expect(rec.binaryUpdateCalls.length).toBe(1);
    expect(rec.detachedSpawns).toEqual([]);
    expect(rec.mgr.restartCalls).toEqual([]);
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
