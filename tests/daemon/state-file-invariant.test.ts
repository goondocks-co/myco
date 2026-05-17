/**
 * Canonical tenet test: self-mutation-discipline state-file invariant.
 *
 * The contract proven here, across the daemon lifecycle operation class:
 *
 *   At any observable moment, `pid alive ⇔ daemon.json exists`.
 *
 * Plus the two intent-file sub-invariants that complete the tenet:
 *
 *   - Restart intent: clear-BEFORE-act. The intent section must be
 *     removed before the supervisor restart is requested, otherwise a
 *     fast respawn re-reads the same intent and loops forever.
 *   - Update intent: clear-AFTER-success. The intent section is removed
 *     only when the installer succeeds; on failure the section is
 *     retained so the next reconcile tick retries.
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
 *       clear-before-act restart contract; retain-on-fail update
 *       contract.
 *   - `tests/hooks/client-kill-no-orphan.test.ts`
 *       killDaemon does NOT unlink daemon.json when the recorded pid is
 *       still alive — cleanup is owned by the successor's reconcile.
 *   - `tests/daemon/intent.test.ts`
 *       Atomic writes and merge/clear semantics for intent.toml.
 *
 * Net-new in this file: cross-cutting round trips that touch more than
 * one primitive in a single test, plus scenarios the per-operation
 * suites do not exercise (notably simultaneous restart + update intent).
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
  mergeIntent,
  readIntent,
} from '../../packages/myco/src/daemon/intent.js';
import { DaemonLogger } from '../../packages/myco/src/daemon/logger.js';
import type {
  DaemonServiceState,
  DaemonState,
} from '../../packages/myco/src/daemon/service-state.js';
import type { DaemonLogger as DaemonLoggerType } from '../../packages/myco/src/daemon/logger.js';

function makeService(dir: string, canonicalPort = 20915): DaemonServiceState {
  const stateDir = join(dir, 'service');
  mkdirSync(stateDir, { recursive: true });
  return {
    scope: 'global',
    stateDir,
    statePath: join(stateDir, 'daemon.json'),
    canonicalPort,
  };
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
  test('round-trip: dead predecessor + stale daemon.json → reconcile cleans, invariant restored', async () => {
    // Cross-cutting integration: simulate a predecessor that exited
    // without removing daemon.json (the new contract — successor owns
    // cleanup). The invariant is violated at the start (file exists,
    // pid dead). reconcileExistingDaemon must restore it.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-roundtrip-'));
    const svc = makeService(dir);

    // Spawn and immediately reap a child to get a guaranteed-dead pid.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => dead.once('exit', () => resolve()));
    const deadPid = dead.pid!;
    expect(pidAlive(deadPid)).toBe(false);

    writeFileSync(svc.statePath, JSON.stringify({ pid: deadPid, port: 12345 }));
    expect(existsSync(svc.statePath)).toBe(true); // invariant violated

    const result = await reconcileExistingDaemon(svc, makeLogger(dir));

    expect(result).toBe('ok');
    // INVARIANT RESTORED: pid not alive AND state file gone.
    expect(pidAlive(deadPid)).toBe(false);
    expect(existsSync(svc.statePath)).toBe(false);
  });

  test('simultaneous restart + update intent — both sections processed in one tick, file fully cleared', async () => {
    // Net-new scenario not covered elsewhere: a user could plausibly
    // queue both intents (e.g. `myco restart` then `myco update`
    // before the daemon has ticked). The reconcile loop must process
    // both deterministically and leave intent.toml fully cleaned when
    // both succeed — otherwise a partial state at next tick could
    // produce surprising behavior (re-restart, re-update).
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-both-intents-'));
    const svc = makeService(dir);
    const logger = makeLogger(dir);
    const state = makeState();

    mergeIntent(svc, {
      restart: { requested_at: new Date().toISOString(), reason: 'tenet-both' },
      update: { target_version: '0.27.99', requested_at: new Date().toISOString() },
    });
    const intentFile = join(svc.stateDir, 'intent.toml');
    expect(existsSync(intentFile)).toBe(true);

    const events: string[] = [];
    await reconcileSelf({
      daemonService: svc,
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => events.push('restart'),
      installUpdate: async (target) => { events.push(`update:${target}`); },
    });

    // Both intents were invoked, restart first (it's processed before
    // update in reconcileSelf; this locks the ordering in).
    expect(events).toEqual(['restart', 'update:0.27.99']);
    // INVARIANT: intent.toml fully gone after both clears.
    expect(existsSync(intentFile)).toBe(false);
    // INVARIANT: daemon.json present and pointing at us.
    expect(existsSync(svc.statePath)).toBe(true);
    const written = JSON.parse(readFileSync(svc.statePath, 'utf-8'));
    expect(written.pid).toBe(state.pid);
  });

  test('simultaneous restart + update where update FAILS — restart still fires, update intent retained', async () => {
    // Net-new corollary: even when one intent's action fails, the
    // other's must still complete, and only the failed intent's
    // section is retained. This proves the two intent sections are
    // independent and that failure containment works.
    const dir = mkdtempSync(join(tmpdir(), 'myco-tenet-update-fail-'));
    const svc = makeService(dir);
    const state = makeState();
    // Use the silent test logger shape from self-reconcile.test.ts —
    // the real DaemonLogger writes to disk, which is fine, but we
    // need to avoid the error being treated as a test failure.
    const logger: DaemonLoggerType = {
      debug() {},
      info() {},
      warn() {},
      error() {},
    } as unknown as DaemonLoggerType;

    mergeIntent(svc, {
      restart: { requested_at: new Date().toISOString(), reason: 'tenet-partial-fail' },
      update: { target_version: '0.27.99', requested_at: new Date().toISOString() },
    });

    let restartCalls = 0;
    let updateCalls = 0;
    await reconcileSelf({
      daemonService: svc,
      currentState: () => state,
      logger,
      requestSupervisorRestart: () => { restartCalls += 1; },
      installUpdate: async () => {
        updateCalls += 1;
        throw new Error('npm registry unreachable');
      },
    });

    // Restart fired, update attempted.
    expect(restartCalls).toBe(1);
    expect(updateCalls).toBe(1);

    // INVARIANT: restart section cleared (it succeeded), update
    // section retained (it failed) — proves clear-before-act for
    // restart and retain-on-fail for update operate independently.
    const intent = readIntent(svc);
    expect(intent.restart).toBeUndefined();
    expect(intent.update?.target_version).toBe('0.27.99');
    // File still exists because update section remains.
    expect(existsSync(join(svc.stateDir, 'intent.toml'))).toBe(true);
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
      //   - State file removed (no orphan pointing at the wrong pid).
      //   - Result is 'ok' — we took over rather than stepping aside
      //     into a non-myco predecessor.
      //   - Stranger untouched: pid-reuse defense must not collateral-
      //     damage unrelated processes.
      expect(result).toBe('ok');
      expect(existsSync(svc.statePath)).toBe(false);
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
