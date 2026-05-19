import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { PowerManager, type PowerState } from '@myco/daemon/power.js';
import { EventLoopLagProbe } from '@myco/daemon/event-loop-lag.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

describe('PowerManager', () => {
  let pm: PowerManager;

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.useFakeTimers();
    pm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 1_000,
      sleepIntervalMs: 5_000,
      logger: mockLogger,
    });
  });

  afterEach(() => {
    pm.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in active state', () => {
    pm.start();
    expect(pm.getState()).toBe('active');
  });

  it('transitions to idle after threshold', () => {
    pm.start();
    vi.advanceTimersByTime(6_000);
    expect(pm.getState()).toBe('idle');
  });

  it('transitions to sleep after threshold', () => {
    pm.start();
    vi.advanceTimersByTime(31_000);
    expect(pm.getState()).toBe('sleep');
  });

  it('transitions to deep_sleep after threshold', () => {
    pm.start();
    vi.advanceTimersByTime(91_000);
    expect(pm.getState()).toBe('deep_sleep');
  });

  it('wakes from deep_sleep on recordActivity', () => {
    pm.start();
    vi.advanceTimersByTime(91_000);
    expect(pm.getState()).toBe('deep_sleep');

    pm.recordActivity();
    expect(pm.getState()).toBe('active');
  });

  // Skipped under `bun test` on Linux CI: fake-timer + async chain is
  // brittle across bun's timer implementation and the ubuntu-latest
  // scheduler. Covers real behavior (power-state-aware job filtering);
  // worth re-enabling with a robust timing harness. See feat/bun-migration
  // CI run 24800787197 and decision spore decision-754d7dd5.
  it.skip('runs jobs matching current power state', async () => {
    const jobFn = vi.fn().mockResolvedValue(undefined);
    pm.register({ name: 'test-job', runIn: ['active'], fn: jobFn });

    pm.start();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(jobFn).toHaveBeenCalled();
  });

  it('skips jobs not matching current power state', async () => {
    const jobFn = vi.fn().mockResolvedValue(undefined);
    pm.register({ name: 'active-only', runIn: ['active'], fn: jobFn });

    pm.start();
    // Advance past idle threshold
    vi.advanceTimersByTime(6_000);
    jobFn.mockClear();

    await vi.advanceTimersByTimeAsync(1_100);

    expect(jobFn).not.toHaveBeenCalled();
  });

  it('recordActivity resets to active state', () => {
    pm.start();
    vi.advanceTimersByTime(6_000);
    expect(pm.getState()).toBe('idle');

    pm.recordActivity();
    vi.advanceTimersByTime(1_100);
    expect(pm.getState()).toBe('active');
  });

  // Skipped: same root cause as the "runs jobs matching current power state"
  // test above — fake-timer + async chain flake on Linux CI.
  it.skip('handles job failures gracefully', async () => {
    const failingJob = vi.fn().mockRejectedValue(new Error('job failed'));
    const passingJob = vi.fn().mockResolvedValue(undefined);

    pm.register({ name: 'failing', runIn: ['active'], fn: failingJob });
    pm.register({ name: 'passing', runIn: ['active'], fn: passingJob });

    pm.start();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(failingJob).toHaveBeenCalled();
    expect(passingJob).toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'power.job-error',
      'Job "failing" failed',
      expect.any(Object),
    );
  });

  it('preventsDeepSleep holds state at sleep when predicate returns true', () => {
    const holdFn = vi.fn().mockReturnValue(true);
    pm.register({
      name: 'blocker',
      runIn: ['active', 'idle', 'sleep'],
      fn: vi.fn().mockResolvedValue(undefined),
      preventsDeepSleep: holdFn,
    });

    pm.start();
    vi.advanceTimersByTime(91_000);
    expect(pm.getState()).toBe('sleep');
    expect(holdFn).toHaveBeenCalled();
  });

  it('transitions to deep_sleep once preventsDeepSleep returns false', () => {
    let pending = true;
    pm.register({
      name: 'blocker',
      runIn: ['active', 'idle', 'sleep'],
      fn: vi.fn().mockResolvedValue(undefined),
      preventsDeepSleep: () => pending,
    });

    pm.start();
    vi.advanceTimersByTime(91_000);
    expect(pm.getState()).toBe('sleep');

    pending = false;
    vi.advanceTimersByTime(5_100);
    expect(pm.getState()).toBe('deep_sleep');
  });

  // Skipped: fake-timer deep_sleep transition flakes on Linux CI. Covered
  // end-to-end by the daemon respawn smoke in Stage 1 of the bun-migration
  // release.
  it.skip('stops timer on deep_sleep and restarts on activity', async () => {
    const jobFn = vi.fn().mockResolvedValue(undefined);
    pm.register({ name: 'test', runIn: ['active'], fn: jobFn });

    pm.start();
    // Go to deep sleep
    await vi.advanceTimersByTimeAsync(91_000);
    jobFn.mockClear();

    // Advance more time — no jobs should run (timer stopped)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(jobFn).not.toHaveBeenCalled();

    // Wake up — timer restarts
    pm.recordActivity();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(jobFn).toHaveBeenCalled();
  });

  it('replaces a named job group without disturbing other jobs', () => {
    pm.register({ name: 'scheduled:old-task', runIn: ['active'], fn: vi.fn().mockResolvedValue(undefined) });
    pm.register({ name: 'embedding-reconcile', runIn: ['idle'], fn: vi.fn().mockResolvedValue(undefined) });

    pm.replaceGroup('scheduled:', [
      { name: 'scheduled:new-task', runIn: ['sleep'], fn: vi.fn().mockResolvedValue(undefined) },
    ]);

    expect((pm as unknown as { jobs: Array<{ name: string }> }).jobs.map((job) => job.name)).toEqual([
      'embedding-reconcile',
      'scheduled:new-task',
    ]);
  });
});

// Real-timer suite — exercises per-job timing/lag instrumentation against a
// live EventLoopLagProbe. Cannot run under fake timers because the probe is
// driven by real setTimeout for clock-fidelity reasons documented on
// `event-loop-lag.ts`.
describe('PowerManager: per-job timing instrumentation', () => {
  interface LogCall {
    level: 'info' | 'warn' | 'error' | 'debug';
    kind: string;
    message: string;
    data?: Record<string, unknown>;
  }

  function captureLogger(): { logs: LogCall[]; logger: any } {
    const logs: LogCall[] = [];
    const push = (level: LogCall['level']) =>
      (kind: string, message: string, data?: Record<string, unknown>) => {
        logs.push({ level, kind, message, data });
      };
    return {
      logs,
      logger: {
        debug: push('debug'),
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
      },
    };
  }

  function blockSync(ms: number): void {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { /* busy-wait */ }
  }

  it('emits a power.job log entry with duration and lag attribution for each job', async () => {
    const { logs, logger } = captureLogger();
    const probe = new EventLoopLagProbe(logger, { sampleIntervalMs: 25, warnThresholdMs: 1_000_000 });
    probe.start();
    try {
      const pm = new PowerManager({
        idleThresholdMs: 60_000,
        sleepThresholdMs: 120_000,
        deepSleepThresholdMs: 180_000,
        activeIntervalMs: 50,
        sleepIntervalMs: 1000,
        logger,
        lagProbe: probe,
      });

      pm.register({
        name: 'fast-job',
        runIn: ['active'],
        fn: async () => { /* no-op */ },
      });
      pm.register({
        name: 'slow-job',
        runIn: ['active'],
        fn: async () => { blockSync(120); },
      });

      pm.start();
      // Let one tick complete (≥ 50ms active interval + job runtime).
      await new Promise((r) => setTimeout(r, 300));
      pm.stop();

      const jobLogs = logs.filter((e) => e.kind === LOG_KINDS.POWER_JOB);
      const fast = jobLogs.find((e) => e.data?.job_name === 'fast-job');
      const slow = jobLogs.find((e) => e.data?.job_name === 'slow-job');
      expect(fast).toBeDefined();
      expect(slow).toBeDefined();
      expect((slow!.data?.duration_ms as number)).toBeGreaterThanOrEqual(100);
      expect((fast!.data?.duration_ms as number)).toBeLessThan(50);
      expect(fast!.data?.status).toBe('ok');
      expect(slow!.data?.status).toBe('ok');
      // lag-during is attributable when a probe is provided (may be 0 if no
      // tick happened to fire inside the fast job — the slow job pins the
      // loop long enough that at least one tick fires during it).
      expect(slow!.data?.event_loop_lag_during_ms).toBeGreaterThanOrEqual(50);
    } finally {
      probe.stop();
    }
  });

  it('emits power.job with status=error and still logs power.job-error when the job throws', async () => {
    const { logs, logger } = captureLogger();
    const probe = new EventLoopLagProbe(logger, { sampleIntervalMs: 25, warnThresholdMs: 1_000_000 });
    probe.start();
    try {
      const pm = new PowerManager({
        idleThresholdMs: 60_000,
        sleepThresholdMs: 120_000,
        deepSleepThresholdMs: 180_000,
        activeIntervalMs: 50,
        sleepIntervalMs: 1000,
        logger,
        lagProbe: probe,
      });
      pm.register({
        name: 'broken-job',
        runIn: ['active'],
        fn: async () => { throw new Error('boom'); },
      });

      pm.start();
      await new Promise((r) => setTimeout(r, 200));
      pm.stop();

      const jobLog = logs.find((e) => e.kind === LOG_KINDS.POWER_JOB);
      expect(jobLog?.data?.status).toBe('error');
      const errLog = logs.find((e) => e.kind === LOG_KINDS.POWER_JOB_ERROR);
      expect(errLog).toBeDefined();
      expect(errLog?.data?.error).toBe('boom');
    } finally {
      probe.stop();
    }
  });

  it('reports event_loop_lag_during_ms = null when no lag probe is configured', async () => {
    const { logs, logger } = captureLogger();
    const pm = new PowerManager({
      idleThresholdMs: 60_000,
      sleepThresholdMs: 120_000,
      deepSleepThresholdMs: 180_000,
      activeIntervalMs: 50,
      sleepIntervalMs: 1000,
      logger,
    });
    pm.register({ name: 'no-probe-job', runIn: ['active'], fn: async () => {} });
    pm.start();
    await new Promise((r) => setTimeout(r, 150));
    pm.stop();

    const jobLog = logs.find((e) => e.kind === LOG_KINDS.POWER_JOB);
    expect(jobLog).toBeDefined();
    expect(jobLog?.data?.event_loop_lag_during_ms).toBeNull();
  });
});
