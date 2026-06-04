import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { PowerManager, type PowerState } from '@myco/daemon/power.js';
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
      onTick: () => {},
      deepSleepHolder: () => null,
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

  it('recordActivity resets to active state', () => {
    pm.start();
    vi.advanceTimersByTime(6_000);
    expect(pm.getState()).toBe('idle');

    pm.recordActivity();
    vi.advanceTimersByTime(1_100);
    expect(pm.getState()).toBe('active');
  });

  it('tick invokes onTick with current state and runs no jobs itself', () => {
    const states: PowerState[] = [];
    const onTickPm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 1_000,
      sleepIntervalMs: 5_000,
      logger: mockLogger,
      onTick: (s) => states.push(s),
      deepSleepHolder: () => null,
    });
    onTickPm.start();
    onTickPm.tickOnceForTest();
    expect(states[0]).toBe('active');
    onTickPm.stop();
  });

  it('holds at sleep instead of deep_sleep when deepSleepHolder returns a name', () => {
    let hold = true;
    const holdPm = new PowerManager({
      idleThresholdMs: 0,
      sleepThresholdMs: 0,
      deepSleepThresholdMs: 0,
      activeIntervalMs: 1,
      sleepIntervalMs: 1,
      logger: mockLogger,
      onTick: () => {},
      deepSleepHolder: () => (hold ? 'embedding-reconcile' : null),
    });
    expect(holdPm.evaluateStateForTest()).toBe('sleep');
    hold = false;
    expect(holdPm.evaluateStateForTest()).toBe('deep_sleep');
  });

  it('logs the holder name when deep sleep is held', () => {
    const holdPm = new PowerManager({
      idleThresholdMs: 0,
      sleepThresholdMs: 0,
      deepSleepThresholdMs: 0,
      activeIntervalMs: 1,
      sleepIntervalMs: 1,
      logger: mockLogger,
      onTick: () => {},
      deepSleepHolder: () => 'team-sync-flush',
    });
    expect(holdPm.evaluateStateForTest()).toBe('sleep');
    expect(mockLogger.info).toHaveBeenCalledWith(
      LOG_KINDS.POWER_STATE,
      'Deep sleep held',
      { by: 'team-sync-flush' },
    );
  });

  it('transitions to deep_sleep once deepSleepHolder returns null', () => {
    let holder: string | null = 'embedding-reconcile';
    const holdPm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 1_000,
      sleepIntervalMs: 5_000,
      logger: mockLogger,
      onTick: () => {},
      deepSleepHolder: () => holder,
    });

    holdPm.start();
    vi.advanceTimersByTime(91_000);
    expect(holdPm.getState()).toBe('sleep');

    holder = null;
    vi.advanceTimersByTime(5_100);
    expect(holdPm.getState()).toBe('deep_sleep');
    holdPm.stop();
  });
});
