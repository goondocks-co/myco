// Compatibility shim mapping the subset of Vitest's `vi` API that Myco's test
// suite actually uses onto bun:test primitives. Imported from codemod-generated
// paths like `../helpers/vi-shim.js`. Keeps existing `vi.fn()`, `mock.module(...)`,
// `vi.spyOn(...)` call sites intact after the vitest -> bun test migration.

import {
  mock,
  spyOn as bunSpyOn,
  setSystemTime as bunSetSystemTime,
} from 'bun:test';

type EnvStackEntry = { key: string; prior: string | undefined; had: boolean };
type GlobalStackEntry = { key: PropertyKey; prior: unknown; had: boolean };

const envStack: EnvStackEntry[] = [];
const globalStack: GlobalStackEntry[] = [];

// Bun's fake timers: bunSetSystemTime(Date) freezes Date.now(). It does NOT
// schedule queued setTimeout callbacks. Our suite's use of timers is limited
// to Date-based clock manipulation in a couple of tests, so this covers it.
let fakeNow: Date | null = null;

function advanceFakeTime(ms: number): void {
  if (fakeNow === null) {
    // Fall back: real time advance is a no-op; log once.
    return;
  }
  fakeNow = new Date(fakeNow.getTime() + ms);
  bunSetSystemTime(fakeNow);
}

async function flushMicrotasks(): Promise<void> {
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
  },
  useRealTimers(): void {
    fakeNow = null;
    bunSetSystemTime();
  },
  advanceTimersByTime(ms: number): void {
    advanceFakeTime(ms);
  },
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    advanceFakeTime(ms);
    await flushMicrotasks();
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
