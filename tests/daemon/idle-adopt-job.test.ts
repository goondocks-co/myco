/**
 * Tests for the `upgrade-adopt` JobRunner job (`buildAdoptJobFn`):
 *
 *   - staged > current + not in-flight → initiateAdopt called once.
 *   - Two consecutive idle ticks → initiateAdopt called EXACTLY ONCE
 *     (the inFlight guard is the idempotency mechanism, not a one-shot flag).
 *   - No staged version → no-op.
 *   - Staged version <= current → no-op (resolveNewestStagedVersion filters).
 *   - In-flight sentinel present → no-op.
 *   - adoptJobFn never throws (failure is contained).
 *   - REGRESSION: JobRunner still dispatches other idle/sleep jobs correctly
 *     when upgrade-adopt is registered (dispatch loop unaffected).
 *   - `active` is NOT in runIn.
 */

import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildAdoptJobFn, type AutoAdoptDeps } from '@myco/upgrade/auto-check.js';
import * as updateInProgress from '@myco/upgrade/in-progress.js';
import {
  versionBinaryPath,
  versionsDir,
} from '@myco/install/managed-binary.js';
import { JobRunner, type RunnerJob } from '@myco/daemon/job-runner.js';
import { POWER_JOB_NAMES } from '@myco/constants/power-jobs.js';
import type { Logger } from '@myco/daemon/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM: NodeJS.Platform = 'linux';
const CURRENT = '1.0.0';
const STAGED = '1.1.0';
const OLDER = '0.9.0';

function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

function noopJob(name: string, overrides: Partial<RunnerJob> = {}): RunnerJob {
  return {
    name, runIn: ['active', 'idle', 'sleep'], kind: 'housekeeping',
    fn: async () => {}, ...overrides,
  };
}

function makeJobRunner() {
  return new JobRunner({ concurrency: 4, logger: silentLogger() });
}

let tmpHome: string;
let stateDir: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-job-test-'));
  tmpHome = path.join(base, 'home');
  stateDir = path.join(base, 'state');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  mock.restore();
});

function makeAdoptDeps(overrides: Partial<AutoAdoptDeps> = {}): AutoAdoptDeps {
  return {
    currentVersion: CURRENT,
    home: tmpHome,
    platform: PLATFORM,
    stateDir,
    daemonPort: 19344,
    projectRoot: tmpHome,
    logger: silentLogger(),
    // Tests bypass the dev-build gate — exercises the full adopt logic.
    isDevBuild: () => false,
    // Tests override resolveServiceLabel and initiateAdopt to avoid real I/O.
    resolveServiceLabel: async () => null,
    initiateAdopt: mock(async () => {}),
    ...overrides,
  };
}

function writeStagedBinary(version: string) {
  const binPath = versionBinaryPath(tmpHome, PLATFORM, version);
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, `fake-binary-${version}`);
}

// ---------------------------------------------------------------------------
// adoptJobFn: basic adopt path
// ---------------------------------------------------------------------------

describe('adoptJobFn: basic adopt path', () => {
  it('calls initiateAdopt when staged > current and not in-flight', async () => {
    writeStagedBinary(STAGED);
    const initiateAdoptMock = mock(async () => {});
    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);

    await fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } });

    expect(initiateAdoptMock).toHaveBeenCalledTimes(1);
    const [opts] = initiateAdoptMock.mock.calls[0] as [import('@myco/upgrade/adopt.js').InitiateAdoptOpts];
    expect(opts.source).toBe('daemon');
    expect(opts.targetVersion).toBe(STAGED);
    expect(opts.prevVersion).toBe(CURRENT);
  });

  it('does NOT call initiateAdopt when no staged version exists', async () => {
    const initiateAdoptMock = mock(async () => {});
    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);

    await fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } });

    expect(initiateAdoptMock).not.toHaveBeenCalled();
  });

  it('does NOT call initiateAdopt when staged version <= current', async () => {
    writeStagedBinary(OLDER);
    const initiateAdoptMock = mock(async () => {});
    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);

    await fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } });

    expect(initiateAdoptMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inFlight guard: once-per-staged-version
// ---------------------------------------------------------------------------

describe('adoptJobFn: inFlight guard (once-per-staged-version, not per-tick)', () => {
  it('calls initiateAdopt EXACTLY ONCE across two consecutive idle ticks', async () => {
    writeStagedBinary(STAGED);

    // After the first tick, initiateAdopt writes the sentinel. We simulate
    // that by writing it ourselves during the mock call.
    let callCount = 0;
    const initiateAdoptMock = mock(async () => {
      callCount++;
      // Simulate the orchestrator writing the sentinel (daemon path does this
      // right before requesting shutdown in real code, but the sentinel is
      // written by self-reconcile or the spawn path; we write it here to
      // replicate what the daemon does after `initiateAdopt` returns).
      updateInProgress.write(stateDir, {
        targetVersion: STAGED,
        startedAt: Date.now(),
        initiator: 'self-reconcile',
      });
    });

    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);
    const ctx = { sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } };

    // Tick 1 — should call initiateAdopt and write sentinel.
    await fn(ctx);
    expect(callCount).toBe(1);
    // Sentinel should now be in-flight.
    expect(updateInProgress.inFlight(stateDir)).not.toBeNull();

    // Tick 2 — inFlight sentinel present → should NOT call initiateAdopt again.
    await fn(ctx);
    expect(callCount).toBe(1); // EXACTLY ONCE — this is the invariant.
  });

  it('no-ops when an in-flight sentinel is already present', async () => {
    writeStagedBinary(STAGED);
    updateInProgress.write(stateDir, {
      targetVersion: STAGED,
      startedAt: Date.now(),
      initiator: 'self-reconcile',
    });

    const initiateAdoptMock = mock(async () => {});
    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);

    await fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } });

    expect(initiateAdoptMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// adoptJobFn: error containment
// ---------------------------------------------------------------------------

describe('adoptJobFn: error containment', () => {
  it('never throws even when initiateAdopt rejects', async () => {
    writeStagedBinary(STAGED);
    const initiateAdoptMock = mock(async () => {
      throw new Error('orchestrator spawn failed');
    });
    const deps = makeAdoptDeps({ initiateAdopt: initiateAdoptMock });
    const fn = buildAdoptJobFn(deps);

    // Must not throw — failure must be swallowed inside the fn body.
    await expect(fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } })).resolves.toBeUndefined();
  });

  it('never throws even when resolveServiceLabel rejects', async () => {
    writeStagedBinary(STAGED);
    const deps = makeAdoptDeps({
      resolveServiceLabel: async () => { throw new Error('schtasks not found'); },
      initiateAdopt: mock(async () => {}),
    });
    const fn = buildAdoptJobFn(deps);

    await expect(fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 2000 } })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: dispatch still works with upgrade-adopt registered
// ---------------------------------------------------------------------------

describe('JobRunner dispatch regression — upgrade-adopt does not starve other jobs', () => {
  it('upgrade-adopt is dispatched on idle but NOT on active', () => {
    const r = makeJobRunner();
    const dispatched: string[] = [];

    // Register a few existing-style housekeeping jobs.
    r.register({
      name: 'log-retention', runIn: ['idle', 'sleep'], kind: 'housekeeping',
      fn: async () => { dispatched.push('log-retention'); },
    });
    r.register({
      name: 'session-maintenance', runIn: ['active', 'idle', 'sleep'], kind: 'housekeeping',
      fn: async () => { dispatched.push('session-maintenance'); },
    });

    // Register the upgrade-adopt job (same shape as production registration).
    const adoptFn = buildAdoptJobFn(makeAdoptDeps());
    r.register({
      name: POWER_JOB_NAMES.UPGRADE_ADOPT,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: adoptFn,
    });

    // On 'active': only session-maintenance qualifies (log-retention and upgrade-adopt excluded).
    r.dispatch('active');
    const activeInFlight = r.inFlightNames();
    expect(activeInFlight).toContain('session-maintenance');
    expect(activeInFlight).not.toContain(POWER_JOB_NAMES.UPGRADE_ADOPT);
    expect(activeInFlight).not.toContain('log-retention');
  });

  it('upgrade-adopt is dispatched on idle alongside other idle jobs', async () => {
    const r = makeJobRunner();
    const dispatched: string[] = [];

    r.register({
      name: 'log-retention', runIn: ['idle', 'sleep'], kind: 'housekeeping',
      fn: async () => { dispatched.push('log-retention'); },
    });

    const adoptFn = buildAdoptJobFn(makeAdoptDeps());
    r.register({
      name: POWER_JOB_NAMES.UPGRADE_ADOPT,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: adoptFn,
    });

    r.dispatch('idle');
    const idleInFlight = r.inFlightNames();

    // Both idle-eligible jobs should be in-flight (concurrency=4 in this test runner).
    expect(idleInFlight).toContain('log-retention');
    expect(idleInFlight).toContain(POWER_JOB_NAMES.UPGRADE_ADOPT);
  });

  it('other housekeeping jobs still run when upgrade-adopt is never-resolving (concurrency test)', () => {
    const r = new JobRunner({ concurrency: 2, logger: silentLogger() });

    // upgrade-adopt hangs (simulates waiting for initiateAdopt).
    r.register({
      name: POWER_JOB_NAMES.UPGRADE_ADOPT,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: () => new Promise<void>(() => {}), // never resolves
    });

    // Another housekeeping job must still get dispatched even if adopt holds a slot.
    r.register({
      name: 'log-retention', runIn: ['idle', 'sleep'], kind: 'housekeeping',
      fn: async () => {},
    });

    r.dispatch('idle');
    const inFlight = r.inFlightNames();
    expect(inFlight).toContain(POWER_JOB_NAMES.UPGRADE_ADOPT);
    expect(inFlight).toContain('log-retention');
    expect(inFlight.length).toBe(2); // cap respected
  });

  it('upgrade-adopt is not dispatched on deep_sleep (not in runIn)', () => {
    const r = makeJobRunner();

    r.register({
      name: POWER_JOB_NAMES.UPGRADE_ADOPT,
      runIn: ['idle', 'sleep'],
      kind: 'housekeeping',
      fn: async () => {},
    });

    // deep_sleep is a valid PowerState but not in upgrade-adopt's runIn.
    r.dispatch('deep_sleep' as import('@myco/daemon/power.js').PowerState);
    expect(r.inFlightNames()).not.toContain(POWER_JOB_NAMES.UPGRADE_ADOPT);
  });
});
