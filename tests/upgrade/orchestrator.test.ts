/**
 * Tests for `runAdopt` — the adopt orchestration path in orchestrator.ts.
 *
 * The four critical scenarios:
 *   1. HAPPY PATH: stop-confirmed → adoptStaged → restart → health=target →
 *      success (error cleared, sentinel cleared, pruneVersions called).
 *   2. CRASH-LOOP: health never reaches target after N attempts →
 *      restoreVersion(prev) + restart + error side-channel + sentinel cleared.
 *   3. NON-SERVICE: `serviceManagedLabel:null` → restarts via direct spawn on
 *      success AND does NOT strand DOWN on failure (the CR-1 lesson).
 *   4. STOP-NOT-CONFIRMED:
 *        - win32: binary NEVER touched, no restart needed (daemon still up).
 *        - POSIX: proceed (inode-replace is safe against a live image).
 *   5. adoptStaged THROWS: restoreVersion(prev) + restart + sentinel cleared.
 *
 * All deps are injected; no real fs ops, no network, no actual daemon.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, type ApplyUpdateDeps, type ApplyAdoptParams } from '@myco/upgrade/orchestrator.js';
import { FakeServiceManager } from '../helpers/fake-service-manager';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-adopt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Deps factory
// ---------------------------------------------------------------------------

interface AdoptRecorder {
  deps: ApplyUpdateDeps;
  mgr: FakeServiceManager;
  restartCount: number;
  adoptCalls: Array<{ version: string }>;
  restoreCalls: Array<{ version: string }>;
  pruneCalls: Array<{ current: string; previous?: string; keep: number }>;
  shutdownCalls: number[];
  healthSequence: Array<{ version?: string } | null>;
  stopConfirmed: boolean;
  adoptThrows: Error | null;
}

interface AdoptRecorderOpts {
  healthSequence?: Array<{ version?: string } | null>;
  /** Version the daemon.json cross-check reports (null = absent/stale). */
  daemonState?: { version?: string } | null;
  stopConfirmed?: boolean;
  adoptThrows?: Error;
  platform?: NodeJS.Platform;
}

function makeAdoptDeps(opts: AdoptRecorderOpts = {}): AdoptRecorder {
  const mgr = new FakeServiceManager();
  const healthQueue = [...(opts.healthSequence ?? [{ version: '1.2.3' }])];
  const stopConfirmed = opts.stopConfirmed ?? true;

  const rec: AdoptRecorder = {
    mgr,
    restartCount: 0,
    adoptCalls: [],
    restoreCalls: [],
    pruneCalls: [],
    shutdownCalls: [],
    healthSequence: healthQueue,
    stopConfirmed,
    adoptThrows: opts.adoptThrows ?? null,
    deps: undefined as never,
  };

  // Count service-manager restarts toward the restart total.
  const realRestart = mgr.restart.bind(mgr);
  mgr.restart = vi.fn(async (label: string) => {
    rec.restartCount += 1;
    return realRestart(label);
  }) as never;

  rec.deps = {
    getServiceManager: () => mgr,
    runNpm: vi.fn(async () => ({ ok: true, output: '' })),
    spawnDetached: vi.fn((bin: string, args: string[], cwd?: string) => {
      rec.restartCount += 1;
    }),
    runFanout: vi.fn(async () => {}),
    probeHealth: vi.fn(async () => {
      return healthQueue.length > 0 ? healthQueue.shift()! : null;
    }),
    probeDaemonState: vi.fn(() => opts.daemonState ?? null),
    sleep: vi.fn(async () => {}),
    adoptStaged: vi.fn(async (params: { version: string }) => {
      rec.adoptCalls.push({ version: params.version });
      if (rec.adoptThrows) throw rec.adoptThrows;
    }),
    restoreVersion: vi.fn(async (_home: string, _platform: NodeJS.Platform, version: string) => {
      rec.restoreCalls.push({ version });
    }),
    requestCooperativeShutdown: vi.fn(async (port: number) => {
      rec.shutdownCalls.push(port);
      return rec.stopConfirmed;
    }),
    pruneVersions: vi.fn(
      (
        _home: string,
        _platform: NodeJS.Platform,
        keep: number,
        current: string,
        previous?: string,
      ) => {
        rec.pruneCalls.push({ keep, current, previous });
      },
    ),
  };

  return rec;
}

// ---------------------------------------------------------------------------
// Base params factory
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<ApplyAdoptParams> = {}): ApplyAdoptParams {
  return {
    kind: 'adopt',
    targetVersion: '1.2.3',
    prevVersion: '1.1.0',
    home: '/home/user/.myco',
    platform: 'linux' as NodeJS.Platform,
    daemonPort: 20915,
    serviceManagedLabel: null,
    mycoBinary: '/home/user/.myco/bin/myco',
    projectRoot: '/home/user/project',
    maxHealthAttempts: 3,
    healthIntervalMs: 5,
    // Keep the adopt-event side-channel hermetic (default is machine-global).
    updateEventsPath: path.join(tmpDir, 'update-events.jsonl'),
    ...overrides,
  };
}

function writeParamsFile(params: ApplyAdoptParams): string {
  const f = path.join(tmpDir, 'adopt-params.json');
  fs.writeFileSync(f, JSON.stringify(params), 'utf-8');
  return f;
}

// ---------------------------------------------------------------------------
// Scenario 1: Happy path
// ---------------------------------------------------------------------------

describe('runAdopt — happy path (stop-confirmed → adoptStaged → restart → healthy → success)', () => {
  it('calls requestCooperativeShutdown with the daemon port', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.shutdownCalls).toContain(20915);
  });

  it('calls adoptStaged with the target version after stop is confirmed', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.adoptCalls).toEqual([{ version: '1.2.3' }]);
  });

  it('restarts the daemon exactly once (no restore / second restart)', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restartCount).toBe(1);
  });

  it('does NOT call restoreVersion on success', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restoreCalls).toEqual([]);
  });

  it('clears the error file on success', async () => {
    const errorPath = path.join(tmpDir, 'update-error.json');
    fs.writeFileSync(errorPath, JSON.stringify({ error: 'prior error' }));

    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams({ errorPath }))], rec.deps);

    expect(fs.existsSync(errorPath)).toBe(false);
  });

  it('clears the sentinel on success', async () => {
    const sentinelPath = path.join(tmpDir, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
    }));

    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams({ inProgressSentinelPath: sentinelPath }))], rec.deps);

    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('calls pruneVersions with the adopted version as current and prevVersion as previous', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams({ keepVersions: 3 }))], rec.deps);

    expect(rec.pruneCalls).toEqual([{ keep: 3, current: '1.2.3', previous: '1.1.0' }]);
  });

  it('service-managed happy path: restarts through ServiceManager, not direct spawn', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(makeParams({ serviceManagedLabel: 'co.goondocks.myco' }))], rec.deps);

    expect(rec.mgr.restartCalls).toEqual(['co.goondocks.myco']);
    // No direct spawn.
    expect(rec.deps.spawnDetached).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Crash-loop
// ---------------------------------------------------------------------------

describe('runAdopt — crash-loop (health never reaches target → restore + restart + error + sentinel cleared)', () => {
  it('calls restoreVersion(prevVersion) after exhausting health attempts', async () => {
    const rec = makeAdoptDeps({
      healthSequence: [null, null, null], // all down
    });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restoreCalls).toEqual([{ version: '1.1.0' }]);
  });

  it('restarts ADOPT_RESTART_ATTEMPTS times before giving up, then once after restore', async () => {
    // Convergence retry: a single failed restart is retried before rolling back,
    // so a genuinely-unhealthy binary is restarted twice (2 attempts) and then
    // once more on the restored prev version = 3 total.
    const rec = makeAdoptDeps({
      healthSequence: [null, null, null],
    });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restartCount).toBe(3);
  });

  it('writes the error side-channel describing the rollback', async () => {
    const errorPath = path.join(tmpDir, 'update-error.json');
    const rec = makeAdoptDeps({
      healthSequence: [null, null, null],
    });
    await run([writeParamsFile(makeParams({ errorPath }))], rec.deps);

    expect(fs.existsSync(errorPath)).toBe(true);
    const err = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(JSON.stringify(err).toLowerCase()).toContain('rollback');
  });

  it('clears the sentinel on crash-loop (daemon restored to prev → startup clear won\'t fire)', async () => {
    const sentinelPath = path.join(tmpDir, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
    }));

    const rec = makeAdoptDeps({ healthSequence: [null, null, null] });
    await run([writeParamsFile(makeParams({ inProgressSentinelPath: sentinelPath }))], rec.deps);

    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('does NOT call pruneVersions after a crash-loop (prune only on success)', async () => {
    const rec = makeAdoptDeps({ healthSequence: [null, null, null] });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.pruneCalls).toEqual([]);
  });

  it('healthy-but-wrong-version across all attempts → also restores', async () => {
    const rec = makeAdoptDeps({
      healthSequence: [{ version: '1.1.0' }, { version: '1.1.0' }, { version: '1.1.0' }],
    });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restoreCalls).toEqual([{ version: '1.1.0' }]);
    // 2 adopt restart attempts + 1 restore restart.
    expect(rec.restartCount).toBe(3);
  });

  it('reaches target on a later attempt (after some nulls) → success, no restore', async () => {
    const rec = makeAdoptDeps({
      healthSequence: [null, { version: '1.2.3' }],
    });
    await run([writeParamsFile(makeParams({ maxHealthAttempts: 3 }))], rec.deps);

    expect(rec.restoreCalls).toEqual([]);
    expect(rec.restartCount).toBe(1);
    expect(rec.pruneCalls.length).toBe(1);
  });

  it('FLAKY-PROBE RESCUE: /health stays dark but daemon.json shows the target → success, no rollback', async () => {
    // The actual root cause of the manual-button rollback: a healthy new daemon
    // whose HTTP /health probe flakes for the entire watch (seen live: /health
    // served the target for 100+s while the orchestrator's probe got null). The
    // daemon.json cross-check (recorded version + live pid) must confirm the adopt
    // instead of rolling back a demonstrably-running new version.
    const rec = makeAdoptDeps({
      healthSequence: [null, null, null], // HTTP probe dead the whole window
      daemonState: { version: '1.2.3' },  // but the daemon recorded the target
    });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restoreCalls).toEqual([]);  // NO rollback
    expect(rec.restartCount).toBe(1);       // landed on attempt 1 via daemon-state
    expect(rec.pruneCalls.length).toBe(1);  // success path
  });

  it('CONVERGENCE: first restart never reaches target, a retried restart does → success, no restore', async () => {
    // The manual one-shot apply and the idle auto-adopt both flow through here;
    // this proves a single transient restart failure (e.g. a respawn racing the
    // restart) converges via the bounded retry instead of rolling back — so the
    // manual button lands without waiting for the idle auto-adopt to re-try.
    // First health-watch (maxHealthAttempts=3) sees only nulls; the SECOND
    // restart's health-watch reports the target on its first probe.
    const rec = makeAdoptDeps({
      healthSequence: [null, null, null, { version: '1.2.3' }],
    });
    await run([writeParamsFile(makeParams({ maxHealthAttempts: 3 }))], rec.deps);

    expect(rec.restoreCalls).toEqual([]);       // no rollback
    expect(rec.restartCount).toBe(2);           // attempt 1 + attempt 2 (which succeeds)
    expect(rec.pruneCalls.length).toBe(1);      // success path pruned
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Non-service path (CR-1 lesson)
// ---------------------------------------------------------------------------

describe('runAdopt — non-service (serviceManagedLabel:null) CR-1 guarantees', () => {
  it('happy path: restarts via direct spawn (spawnDetached), not ServiceManager', async () => {
    const params = makeParams({ serviceManagedLabel: null });
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    await run([writeParamsFile(params)], rec.deps);

    expect(rec.deps.spawnDetached).toHaveBeenCalledTimes(1);
    expect(rec.mgr.restartCalls).toEqual([]);
    // Spawned binary must be the managed myco binary from params.
    const [spawnedBin] = (rec.deps.spawnDetached as ReturnType<typeof vi.fn>).mock.calls[0] as [string, ...unknown[]];
    expect(spawnedBin).toBe(params.mycoBinary);
  });

  it('crash-loop: restarts on every attempt then once after restore — never strands DOWN', async () => {
    const sentinelPath = path.join(tmpDir, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
    }));

    const rec = makeAdoptDeps({ healthSequence: [null, null, null] });
    await run([writeParamsFile(makeParams({ serviceManagedLabel: null, inProgressSentinelPath: sentinelPath }))], rec.deps);

    // ADOPT_RESTART_ATTEMPTS (2) restart attempts + 1 restore restart = 3 — the
    // daemon NEVER stays down on the non-service path.
    expect(rec.restartCount).toBe(3);
    expect(rec.restoreCalls).toEqual([{ version: '1.1.0' }]);
    // clearSentinel is unconditional — must fire on the non-service path too (CR-1).
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('adoptStaged throws (non-service): restoreVersion + restart → sentinel cleared', async () => {
    const adoptErr = new Error('chmod failed');
    const sentinelPath = path.join(tmpDir, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
    }));

    const rec = makeAdoptDeps({ adoptThrows: adoptErr });
    await run([writeParamsFile(makeParams({
      serviceManagedLabel: null,
      inProgressSentinelPath: sentinelPath,
    }))], rec.deps);

    // restoreVersion is called with the previous version.
    expect(rec.restoreCalls).toEqual([{ version: '1.1.0' }]);
    // Daemon is restarted exactly once (after restore).
    expect(rec.restartCount).toBe(1);
    // Sentinel is cleared.
    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('service-restart throws → falls back to direct spawn (never strands)', async () => {
    const rec = makeAdoptDeps({ healthSequence: [{ version: '1.2.3' }] });
    rec.mgr.restart = vi.fn(async () => { throw new Error('kickstart blew up'); }) as never;
    await run([writeParamsFile(makeParams({ serviceManagedLabel: 'co.goondocks.myco' }))], rec.deps);

    // Fell back to direct spawn.
    expect(rec.deps.spawnDetached).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Stop-not-confirmed
// ---------------------------------------------------------------------------

describe('runAdopt — stop-not-confirmed', () => {
  describe('win32: NEVER touches the binary or restarts (daemon is still live)', () => {
    it('abort safely: adoptStaged is NOT called', async () => {
      const rec = makeAdoptDeps({ stopConfirmed: false });
      await run([writeParamsFile(makeParams({ platform: 'win32' }))], rec.deps);

      expect(rec.adoptCalls).toEqual([]);
    });

    it('abort safely: NO restart of any kind (daemon is still answering)', async () => {
      const rec = makeAdoptDeps({ stopConfirmed: false });
      await run([writeParamsFile(makeParams({ platform: 'win32' }))], rec.deps);

      expect(rec.restartCount).toBe(0);
      expect(rec.deps.spawnDetached).not.toHaveBeenCalled();
      expect(rec.mgr.restartCalls).toEqual([]);
    });

    it('abort safely: error side-channel written (explains why adopt aborted)', async () => {
      const errorPath = path.join(tmpDir, 'update-error.json');
      const rec = makeAdoptDeps({ stopConfirmed: false });
      await run([writeParamsFile(makeParams({ platform: 'win32', errorPath }))], rec.deps);

      expect(fs.existsSync(errorPath)).toBe(true);
      const err = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
      expect(typeof err.error).toBe('string');
    });

    it('abort safely: sentinel is cleared (so next update is not blocked)', async () => {
      const sentinelPath = path.join(tmpDir, 'update.in-progress');
      fs.writeFileSync(sentinelPath, JSON.stringify({
        targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
      }));
      const rec = makeAdoptDeps({ stopConfirmed: false });
      await run([writeParamsFile(makeParams({ platform: 'win32', inProgressSentinelPath: sentinelPath }))], rec.deps);

      expect(fs.existsSync(sentinelPath)).toBe(false);
    });

    it('stop-not-confirmed on win32 with a service label: still does NOT copy or restart', async () => {
      const rec = makeAdoptDeps({ stopConfirmed: false });
      await run([writeParamsFile(makeParams({
        platform: 'win32',
        serviceManagedLabel: 'co.goondocks.myco',
      }))], rec.deps);

      expect(rec.adoptCalls).toEqual([]);
      expect(rec.restartCount).toBe(0);
      expect(rec.mgr.restartCalls).toEqual([]);
    });
  });

  describe('POSIX: proceed (inode-replace is safe against a live image)', () => {
    it('stop-not-confirmed on linux: adoptStaged IS called (inode-replace is safe)', async () => {
      const rec = makeAdoptDeps({
        stopConfirmed: false,
        healthSequence: [{ version: '1.2.3' }],
      });
      await run([writeParamsFile(makeParams({ platform: 'linux' }))], rec.deps);

      // On POSIX, we proceed regardless of stop-confirm.
      expect(rec.adoptCalls).toEqual([{ version: '1.2.3' }]);
    });

    it('stop-not-confirmed on darwin: proceeds and restarts normally', async () => {
      const rec = makeAdoptDeps({
        stopConfirmed: false,
        healthSequence: [{ version: '1.2.3' }],
      });
      await run([writeParamsFile(makeParams({ platform: 'darwin' }))], rec.deps);

      expect(rec.adoptCalls).toEqual([{ version: '1.2.3' }]);
      expect(rec.restartCount).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: adoptStaged throws
// ---------------------------------------------------------------------------

describe('runAdopt — adoptStaged throws', () => {
  it('calls restoreVersion(prevVersion) when adoptStaged throws', async () => {
    const adoptErr = new Error('rename failed');
    const rec = makeAdoptDeps({ adoptThrows: adoptErr });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restoreCalls).toEqual([{ version: '1.1.0' }]);
  });

  it('restarts exactly once after adopt failure + restore', async () => {
    const rec = makeAdoptDeps({ adoptThrows: new Error('chmod failed') });
    await run([writeParamsFile(makeParams())], rec.deps);

    expect(rec.restartCount).toBe(1);
  });

  it('clears the sentinel after adoptStaged throws', async () => {
    const sentinelPath = path.join(tmpDir, 'update.in-progress');
    fs.writeFileSync(sentinelPath, JSON.stringify({
      targetVersion: '1.2.3', startedAt: Date.now(), initiator: 'api/update/apply',
    }));
    const rec = makeAdoptDeps({ adoptThrows: new Error('fs error') });
    await run([writeParamsFile(makeParams({ inProgressSentinelPath: sentinelPath }))], rec.deps);

    expect(fs.existsSync(sentinelPath)).toBe(false);
  });

  it('writes an error to the error side-channel when adoptStaged throws', async () => {
    const errorPath = path.join(tmpDir, 'update-error.json');
    const rec = makeAdoptDeps({ adoptThrows: new Error('copy failed') });
    await run([writeParamsFile(makeParams({ errorPath }))], rec.deps);

    expect(fs.existsSync(errorPath)).toBe(true);
    const err = JSON.parse(fs.readFileSync(errorPath, 'utf-8'));
    expect(err.error.toLowerCase()).toContain('adoptstaged failed');
  });

  it('does NOT probe health when adoptStaged throws (no restart yet → no health to check)', async () => {
    const rec = makeAdoptDeps({ adoptThrows: new Error('copy failed') });
    await run([writeParamsFile(makeParams())], rec.deps);

    // probeHealth should NOT have been called — we never restarted the new binary.
    expect(rec.deps.probeHealth).not.toHaveBeenCalled();
  });

  it('non-service + adoptStaged throws: still restarts (daemon NEVER strands DOWN)', async () => {
    const rec = makeAdoptDeps({ adoptThrows: new Error('rename failed') });
    await run([writeParamsFile(makeParams({ serviceManagedLabel: null }))], rec.deps);

    expect(rec.restartCount).toBe(1);
    expect(rec.deps.spawnDetached).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Existing kind:restart and kind:update paths must be UNTOUCHED
// ---------------------------------------------------------------------------

describe('runAdopt — existing paths untouched', () => {
  it('kind:restart path still works normally (backward compat)', async () => {
    const rec = makeAdoptDeps();
    const reasonPath = path.join(tmpDir, 'restart-reason.json');
    const restartParams = {
      kind: 'restart' as const,
      projectRoot: '/project',
      vaultDir: '/project/.myco',
      runLocalUpdate: false,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      mycoBinary: 'myco',
      serviceManagedLabel: null,
      daemonPort: 20915,
      restartReasonPath: reasonPath,
    };
    const f = path.join(tmpDir, 'restart-params.json');
    fs.writeFileSync(f, JSON.stringify(restartParams), 'utf-8');

    // adoptStaged and restoreVersion must NOT be called on the restart path.
    await run([f], rec.deps);

    expect(rec.adoptCalls).toEqual([]);
    expect(rec.restoreCalls).toEqual([]);
    // The restart-reason file should have been written.
    expect(fs.existsSync(reasonPath)).toBe(true);
  });
});
