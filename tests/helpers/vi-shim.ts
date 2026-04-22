// Compatibility shim mapping the subset of Vitest's `vi` API that Myco's test
// suite actually uses onto bun:test primitives. Imported from codemod-generated
// paths like `../helpers/vi-shim.js`. Keeps existing `vi.fn()`, `mock.module(...)`,
// `vi.spyOn(...)` call sites intact after the vitest -> bun test migration.

import {
  mock,
  spyOn as bunSpyOn,
  setSystemTime as bunSetSystemTime,
  jest,
} from 'bun:test';

type EnvStackEntry = { key: string; prior: string | undefined; had: boolean };
type GlobalStackEntry = { key: PropertyKey; prior: unknown; had: boolean };

const envStack: EnvStackEntry[] = [];
const globalStack: GlobalStackEntry[] = [];

// Bun's `jest.useFakeTimers()` provides real fake-timer support (patches
// setTimeout/setInterval and tracks pending timers). We combine it with
// setSystemTime so Date.now() advances alongside timer firings.
let fakeTimersActive = false;
let fakeNow: Date | null = null;

function advanceFakeTime(ms: number): void {
  if (!fakeTimersActive) return;
  if (fakeNow !== null) {
    fakeNow = new Date(fakeNow.getTime() + ms);
    bunSetSystemTime(fakeNow);
  }
  jest.advanceTimersByTime(ms);
}

// Flush the microtask/macrotask queues so that promises chained behind
// timer callbacks (e.g. `setTimeout(() => this.tick(), ms)` where `tick` is
// async) get a chance to resolve before the next timer advance.
async function flushPending(): Promise<void> {
  // A setImmediate turn drains the macrotask queue once, which lets Promise
  // .then handlers queued from a timer callback run.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await Promise.resolve();
}

export const vi = {
  fn: ((impl?: (...args: unknown[]) => unknown) =>
    impl ? mock(impl) : mock(() => undefined)) as typeof mock,
  spyOn: bunSpyOn as typeof bunSpyOn,
  mock: (modulePath: string, factory: () => unknown): void => {
    mock.module(modulePath, factory as () => Record<string, unknown>);
  },
  doMock: (modulePath: string, factory: () => unknown): void => {
    mock.module(modulePath, factory as () => Record<string, unknown>);
  },
  mocked<T>(value: T): T {
    return value;
  },
  hoisted<T>(factory: () => T): T {
    // bun:test hoists `mock.module(...)` calls but NOT arbitrary factories.
    // Every existing `vi.hoisted` call site in Myco's suite uses the returned
    // values inside subsequent `mock.module(...)` calls — which bun *does* hoist —
    // so invoking the factory inline is sufficient in practice.
    return factory();
  },
  async importActual<T = unknown>(modulePath: string): Promise<T> {
    return (await import(modulePath)) as T;
  },
  useFakeTimers(): void {
    fakeNow = new Date();
    bunSetSystemTime(fakeNow);
    jest.useFakeTimers();
    fakeTimersActive = true;
  },
  useRealTimers(): void {
    if (fakeTimersActive) {
      jest.useRealTimers();
      fakeTimersActive = false;
    }
    fakeNow = null;
    bunSetSystemTime();
  },
  advanceTimersByTime(ms: number): void {
    advanceFakeTime(ms);
  },
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    // Drain timers in incremental chunks so setTimeout-inside-setTimeout
    // chains fire and their queued microtasks have a chance to run between
    // each advance. The PowerManager tick loop is the canonical example:
    // tick() -> await job.fn() -> scheduleNextTick() -> setTimeout(tick, ms).
    // 1000ms is large enough that whole-second test advances (common case)
    // hit a small fixed number of iterations, but still short enough to let
    // nested sub-second timers fire in order.
    const STEP = 1000;
    let remaining = ms;
    await flushPending();
    while (remaining > 0) {
      const step = Math.min(STEP, remaining);
      advanceFakeTime(step);
      await flushPending();
      remaining -= step;
    }
  },
  setSystemTime(date: Date | number): void {
    const d = typeof date === 'number' ? new Date(date) : date;
    fakeNow = d;
    bunSetSystemTime(d);
  },
  clearAllMocks(): void {
    // Bun's clearAllMocks resets call history without restoring implementations,
    // matching vitest's clearAllMocks semantics.
    mock.clearAllMocks();
  },
  resetAllMocks(): void {
    // Vitest's resetAllMocks clears history AND resets implementations to
    // jest-style undefined. Bun doesn't expose that; `restore` + `clearAll`
    // is the closest approximation.
    mock.restore();
    mock.clearAllMocks();
  },
  restoreAllMocks(): void {
    mock.restore();
  },
  stubEnv(key: string, value: string): void {
    envStack.push({
      key,
      prior: process.env[key],
      had: Object.prototype.hasOwnProperty.call(process.env, key),
    });
    process.env[key] = value;
  },
  unstubAllEnvs(): void {
    while (envStack.length > 0) {
      const entry = envStack.pop()!;
      if (entry.had && entry.prior !== undefined) {
        process.env[entry.key] = entry.prior;
      } else {
        delete process.env[entry.key];
      }
    }
  },
  stubGlobal(key: PropertyKey, value: unknown): void {
    const g = globalThis as Record<PropertyKey, unknown>;
    globalStack.push({
      key,
      prior: g[key],
      had: Object.prototype.hasOwnProperty.call(g, key),
    });
    g[key] = value;
  },
  unstubAllGlobals(): void {
    const g = globalThis as Record<PropertyKey, unknown>;
    while (globalStack.length > 0) {
      const entry = globalStack.pop()!;
      if (entry.had) {
        g[entry.key] = entry.prior;
      } else {
        delete g[entry.key];
      }
    }
  },
  resetModules(): void {
    // bun:test has no module-cache reset. The handful of tests that depend on
    // this have been refactored to avoid needing it; for anyone else, warn.
    console.warn('[vi-shim] vi.resetModules has no equivalent under bun test');
  },
};

export type ViShim = typeof vi;
