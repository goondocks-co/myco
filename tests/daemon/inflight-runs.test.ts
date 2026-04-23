import { describe, expect, it } from 'bun:test';
import { InflightRunRegistry } from '@myco/daemon/inflight-runs.js';

describe('InflightRunRegistry', () => {
  it('registers a promise and removes it once it settles', async () => {
    const registry = new InflightRunRegistry();
    let resolveFn!: () => void;
    const p = new Promise<void>((resolve) => { resolveFn = resolve; });

    registry.register(p);
    expect(registry.size).toBe(1);

    resolveFn();
    // Allow the finally handler to execute
    await registry.drain(100);
    expect(registry.size).toBe(0);
  });

  it('tracks rejected promises without propagating the rejection', async () => {
    const registry = new InflightRunRegistry();
    let rejectFn!: (err: Error) => void;
    const p = new Promise<void>((_resolve, reject) => { rejectFn = reject; });

    registry.register(p);
    // Prevent unhandled rejection
    p.catch(() => {});
    expect(registry.size).toBe(1);

    rejectFn(new Error('boom'));
    const outcome = await registry.drain(100);
    expect(outcome.settled).toBe(true);
    expect(outcome.remaining).toBe(0);
  });

  it('drain resolves immediately when the registry is empty', async () => {
    const registry = new InflightRunRegistry();
    const outcome = await registry.drain(5_000);
    expect(outcome).toEqual({ settled: true, remaining: 0 });
  });

  it('returns settled=false when runs exceed the drain timeout', async () => {
    const registry = new InflightRunRegistry();
    // Never-settling promise — we rely on the drain timeout to bound the wait.
    const pending = new Promise<void>(() => {});
    registry.register(pending);

    const start = Date.now();
    const outcome = await registry.drain(50);
    const elapsed = Date.now() - start;

    expect(outcome.settled).toBe(false);
    expect(outcome.remaining).toBeGreaterThanOrEqual(1);
    // Allow generous slack — CI can be noisy but shouldn't exceed an order of magnitude.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('awaits multiple in-flight runs concurrently in drain()', async () => {
    const registry = new InflightRunRegistry();
    const resolvers: Array<() => void> = [];
    for (let i = 0; i < 3; i += 1) {
      registry.register(new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }));
    }
    expect(registry.size).toBe(3);

    // Resolve them asynchronously
    setTimeout(() => resolvers.forEach((fn) => fn()), 10);

    const outcome = await registry.drain(500);
    expect(outcome.settled).toBe(true);
    expect(outcome.remaining).toBe(0);
  });
});
