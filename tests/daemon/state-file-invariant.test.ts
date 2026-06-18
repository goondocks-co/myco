/**
 * Canonical tenet test: self-mutation-discipline state-file invariant.
 *
 * The contract proven here, across the daemon lifecycle operation class:
 *
 *   At any observable moment during steady-state succession,
 *   `daemon.json exists`. Reconcile preserves the predecessor's record
 *   so the successor's atomic write overwrites in place without a
 *   visibly-absent window. The self-reconciler heartbeat is the
 *   backstop for the rare case where succession itself crashes.
 *
 * Plus the restart-intent sub-invariant that completes the tenet:
 *
 *   - Restart intent: clear-BEFORE-act. The intent section must be
 *     removed before the supervisor restart is requested, otherwise a
 *     fast respawn re-reads the same intent and loops forever.
 *
 * Note: the `[update]` intent sub-invariant (clear-AFTER-success) was
 * removed in the Task 9 refactor — binary upgrades now drive directly
 * via `initiateAdopt` paths and the [update] intent surface is gone.
 *
 * This file is the SINGLE place a future reader should land to see the
 * tenet proven end-to-end across operations. Per-operation tests cover
 * specific paths in depth — they are referenced here, not duplicated:
 *
 *   - `tests/daemon/reconcile-existing-daemon.test.ts`
 *       Takeover/step-aside matrix, SIGTERM→SIGKILL escalation+poll,
 *       step-aside when pid survives SIGKILL, stale grace window.
 *   - `tests/daemon/self-reconcile.test.ts`
 *       Heartbeat re-asserts daemon.json after external deletion;
 *       clear-before-act restart contract.
 *   - `tests/hooks/client-kill-no-orphan.test.ts`
 *       killDaemon does NOT unlink daemon.json when the recorded pid is
 *       still alive — cleanup is owned by the successor's reconcile.
 *   - `tests/daemon/intent.test.ts`
 *       Atomic writes and clear semantics for intent.restart.toml.
 *
 * Net-new in this file: cross-cutting round trips that touch more than
 * one primitive in a single test.
 *
 * See `docs/superpowers/plans/2026-05-16-self-mutation-discipline.md`.
 */
import { describe, test, expect } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileExistingDaemon } from '../../packages/myco/src/daemon/main.js';
import { reconcileSelf } from '../../packages/myco/src/daemon/self-reconcile.js';
import {
  readIntent,
  writeRestartIntent,
} from '../../packages/myco/src/daemon/intent.js';
import { DaemonLogger } from '../../packages/myco/src/daemon/logger.js';
import type {
  DaemonServiceState,
  DaemonState,
  DaemonStatePath,
} from '../../packages/myco/src/daemon/service-state.js';
import {
  createDaemonStateAuthority,
  type DaemonStateAuthority,
} from '../../packages/myco/src/daemon/daemon-state-authority.js';
import type { DaemonLogger as DaemonLoggerType } from '../../packages/myco/src/daemon/logger.js';

function makeService(dir: string, canonicalPort = 20915): DaemonServiceState {
  const stateDir = join(dir, 'service');
  mkdirSync(stateDir, { recursive: true });
  return {
    scope: 'global',
    stateDir,
    statePath: join(stateDir, 'daemon.json') as DaemonStatePath,
    lockPath: join(stateDir, 'daemon.lock'),
    canonicalPort,
  };
}

function makeAuthority(svc: DaemonServiceState): DaemonStateAuthority {
  return createDaemonStateAuthority(svc, { info: () => {} });
}

function makeLogger(dir: string): DaemonLoggerType {
  return new DaemonLogger(join(dir, 'logs'), { level: 'info' });
}

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    pid: process.pid,
    port: 20915,
    command: process.execPath,
    started: new Date().toISOString(),
    sessions: [],
    version: '0.27.10',
    auth_token: 'tok-tenet',
    ...overrides,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('self-mutation-discipline invariants', () => {
  test('round-trip: dead predecessor + stale daemon.json → reconcile preserves file for successor overwrite', async () => {
    // Cross-cutting integration: predecessor exited leaving stale
    // daemon.json. New contract: reconcile returns 'ok' without
    // touching the file. The successor's server.start() atomic write
    // (simulated here via an in-place rewrite) overwrites the stale
    // contents — closing the absence window that the previous
    // delete-then-write shape introduced.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-roundtrip-'));
    const svc = makeService(dir);

    // Spawn and immediately reap a child to get a guaranteed-dead pid.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const deadPid = dead.pid!;
    expect(pidAlive(deadPid)).toBe(false);

    writeFileSync(svc.statePath, JSON.stringify({ pid: deadPid, port: 12345 }));
    expect(existsSync(svc.statePath)).toBe(true);

    const result = await reconcileExistingDaemon(svc, makeLogger(dir));

    expect(result).toBe('ok');
    expect(pidAlive(deadPid)).toBe(false);
    // Reconcile preserves the file — no absence window.
    expect(existsSync(svc.statePath)).toBe(true);

    // Simulate the successor's atomic write that follows reconcile.
    const successor = makeState({ pid: process.pid });
    writeFileSync(svc.statePath, JSON.stringify(successor));

    // INVARIANT: file present and now reflects the successor.
    expect(existsSync(svc.statePath)).toBe(true);
    const observed = JSON.parse(readFileSync(svc.statePath, 'utf-8'));
    expect(observed.pid).toBe(successor.pid);
  });

  test('restart intent: clear-before-act — intent section cleared before supervisor restart fires', async () => {
    // Verifies the restart sub-invariant: intent.restart.toml must be
    // removed BEFORE the supervisor restart is requested, so a fast
    // respawn cannot observe the file and trigger an infinite loop.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-restart-clear-'));
    const svc = makeService(dir);
    const logger = makeLogger(dir);
    const state = makeState();

    writeRestartIntent(svc, { requested_at: new Date().toISOString(), reason: 'tenet-restart' });
    const restartFile = join(svc.stateDir, 'intent.restart.toml');
    expect(existsSync(restartFile)).toBe(true);

    const events: string[] = [];
    let restartFilePresentAtRestartTime: boolean | null = null;
    await reconcileSelf({
      daemonService: svc,
      stateAuthority: makeAuthority(svc),
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => {
        restartFilePresentAtRestartTime = existsSync(restartFile);
        events.push('restart');
      },
    });

    expect(events).toEqual(['restart']);
    // INVARIANT: restart section was already cleared by the time the
    // supervisor restart callback fired.
    expect(restartFilePresentAtRestartTime).toBe(false);
    expect(existsSync(restartFile)).toBe(false);
    // INVARIANT: daemon.json present and pointing at us.
    expect(existsSync(svc.statePath)).toBe(true);
    const written = JSON.parse(readFileSync(svc.statePath, 'utf-8'));
    expect(written.pid).toBe(state.pid);
  });

  test('[update] intent surface is gone — intent.ts no longer exposes update fields', () => {
    // Structural regression guard: the Intent type must not have an
    // `update` field (removed in Task 9). If someone re-adds the field,
    // this test fails immediately.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-no-update-'));
    mkdirSync(join(dir, 'service'), { recursive: true });
    const svc: DaemonServiceState = {
      scope: 'global',
      stateDir: join(dir, 'service'),
      statePath: join(dir, 'service', 'daemon.json') as DaemonStatePath,
      lockPath: join(dir, 'service', 'daemon.lock'),
      canonicalPort: 20915,
    };
    const intent = readIntent(svc);
    // The intent object must not carry an `update` field.
    expect('update' in intent).toBe(false);
  });

  test('pid-reuse defense: stale daemon.json pointing at a recycled pid → takeover without orphaning the stranger', async () => {
    // The literal invariant `pid alive ⇔ daemon.json exists` would be
    // fooled if the OS recycled the recorded pid for an unrelated
    // process between the predecessor's exit and the successor's
    // startup. Two defenses combine:
    //   1. Freshness window — mtime older than
    //      DAEMON_STALE_GRACE_PERIOD_MS denies the step-aside path.
    //   2. Health probe — even within the window, a non-myco process
    //      on the recorded port fails the /health check.
    // Together they force the successor through the eviction path,
    // where the kill+poll ladder decides cleanup. This test stands a
    // real child process in for the "recycled-pid stranger" and
    // injects test-only kill/alive seams so we drive the ladder
    // without actually signalling the (innocent) stranger.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-pid-reuse-'));
    const svc = makeService(dir);

    const stranger: ChildProcess = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},60000)'],
      { stdio: 'ignore' },
    );
    await new Promise<void>((resolve) => stranger.once('spawn', () => resolve()));
    const strangerPid = stranger.pid!;
    try {
      writeFileSync(
        svc.statePath,
        JSON.stringify({ pid: strangerPid, port: 1 /* health probe fails */ }),
      );
      // Backdate mtime well past the 60s grace — represents a stale
      // file whose pid was recycled by the OS during the interim.
      const ancient = (Date.now() - 10 * 60 * 1000) / 1000;
      utimesSync(svc.statePath, ancient, ancient);

      // Drive the eviction ladder deterministically:
      //   - `isProcessAlive` claims alive on first call (so we enter
      //     the kill path), then dead (so SIGTERM's waitForExit
      //     reports success and we unlink). This models the recycled
      //     pid being released by the OS during the brief eviction
      //     window without actually killing the stranger child.
      //   - `kill` is a no-op — we never want to SIGTERM the stranger.
      const aliveSequence = [true, false];
      const result = await reconcileExistingDaemon(svc, makeLogger(dir), {
        kill: () => { /* swallow — do not signal the stranger */ },
        isProcessAlive: () => aliveSequence.shift() ?? false,
        sigtermGraceMs: 100,
        sigkillGraceMs: 100,
        pollMs: 10,
      });

      // INVARIANTS:
      //   - Result is 'ok' — we took over rather than stepping aside
      //     into a non-myco predecessor.
      //   - State file preserved — successor's upcoming server.start()
      //     atomic write overwrites the stale recycled-pid record. The
      //     old delete-then-write shape would have produced an absence
      //     window; the new shape leaves the file present at every
      //     observable moment.
      //   - Stranger untouched: pid-reuse defense must not collateral-
      //     damage unrelated processes.
      expect(result).toBe('ok');
      expect(existsSync(svc.statePath)).toBe(true);
      expect(pidAlive(strangerPid)).toBe(true);
    } finally {
      stranger.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (stranger.exitCode !== null || stranger.signalCode !== null) return resolve();
        stranger.once('exit', () => resolve());
      });
    }
  });
});
