import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PowerManager, type PowerState } from '../../src/daemon/power.js';

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

  it('runs jobs matching current power state', async () => {
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

  it('handles job failures gracefully', async () => {
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

  it('stops timer on deep_sleep and restarts on activity', async () => {
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
});
