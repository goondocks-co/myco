import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { PowerManager, type PowerState } from '@myco/daemon/power.js';

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
      shouldHoldDeepSleep: () => false,
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
      shouldHoldDeepSleep: () => false,
    });
    onTickPm.start();
    onTickPm.tickOnceForTest();
    expect(states[0]).toBe('active');
    onTickPm.stop();
  });

  it('holds at sleep instead of deep_sleep when shouldHoldDeepSleep is true', () => {
    let hold = true;
    const holdPm = new PowerManager({
      idleThresholdMs: 0,
      sleepThresholdMs: 0,
      deepSleepThresholdMs: 0,
      activeIntervalMs: 1,
      sleepIntervalMs: 1,
      logger: mockLogger,
      onTick: () => {},
      shouldHoldDeepSleep: () => hold,
    });
    expect(holdPm.evaluateStateForTest()).toBe('sleep');
    hold = false;
    expect(holdPm.evaluateStateForTest()).toBe('deep_sleep');
  });

  it('transitions to deep_sleep once shouldHoldDeepSleep returns false', () => {
    let pending = true;
    const holdPm = new PowerManager({
      idleThresholdMs: 5_000,
      sleepThresholdMs: 30_000,
      deepSleepThresholdMs: 90_000,
      activeIntervalMs: 1_000,
      sleepIntervalMs: 5_000,
      logger: mockLogger,
      onTick: () => {},
      shouldHoldDeepSleep: () => pending,
    });

    holdPm.start();
    vi.advanceTimersByTime(91_000);
    expect(holdPm.getState()).toBe('sleep');

    pending = false;
    vi.advanceTimersByTime(5_100);
    expect(holdPm.getState()).toBe('deep_sleep');
    holdPm.stop();
  });
});
