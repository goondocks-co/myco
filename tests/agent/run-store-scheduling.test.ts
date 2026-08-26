/**
 * Gate: a burst of RunStore operations does not starve the timer phase.
 *
 * `phase-loop.ts:1507-1513` hands control back to libuv between waves because
 * back-to-back waves "can keep the timer/poll phases starved long enough for
 * PowerManager ticks and the `/health` listener to miss their scheduling
 * windows". That yield is calibrated against a checkpoint written with
 * synchronous `bun:sqlite`; routing the write through an async port changes
 * when the loop yields, and no behavioural test covers it — a starved
 * PowerManager tick shows up as a job that silently did not run, not as a
 * failing assertion.
 *
 * So the property is asserted directly: with a timer armed, a long run of
 * store operations must let that timer fire before the burst completes.
 *
 * The control matters as much as the gate. A store whose operations resolve
 * synchronously (no real I/O, resolved promises only) starves the timer, which
 * is exactly the shape a naive implementation would have — so a passing gate
 * means the yielding is real rather than that the burst was too short to
 * matter.
 */
import { describe, expect, it } from 'bun:test';
import { serializeRunStore, type RunStore } from '@myco/agent/runtime/run-store.js';

/**
 * A timer's delay is a floor, so the burst is bounded by WALL TIME rather than
 * iteration count: a fixed number of operations can finish before the timer is
 * even due, which measures loop speed instead of scheduling fairness.
 */
const TIMER_MS = 5;
const BURST_MS = TIMER_MS * 4;
const HARD_CAP = 100_000;

/** Busies the loop with `operation` and reports whether an armed timer got a slot. */
async function timerFiresDuring(operation: () => Promise<unknown>): Promise<boolean> {
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, TIMER_MS);
  const deadline = performance.now() + BURST_MS;

  for (let i = 0; i < HARD_CAP && !fired && performance.now() < deadline; i += 1) {
    await operation();
  }

  clearTimeout(timer);
  return fired;
}

/** A store whose work never reaches the macrotask queue. */
const microtaskOnlyStore = {
  setState: () => Promise.resolve(),
} as unknown as RunStore;

/** A store that yields to libuv, as a real I/O-backed one does. */
const yieldingStore = {
  setState: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
} as unknown as RunStore;

describe('RunStore scheduling', () => {
  it('CONTROL: a microtask-only store starves the timer', async () => {
    const store = serializeRunStore(microtaskOnlyStore);
    const fired = await timerFiresDuring(() => store.setState('k', 'v', 'proj'));

    // A resolved promise stays on the microtask queue, so libuv never runs
    // its timer phase no matter how long the burst lasts.
    expect(fired).toBe(false);
  });

  it('a store that reaches libuv lets the timer fire mid-burst', async () => {
    const store = serializeRunStore(yieldingStore);
    const fired = await timerFiresDuring(() => store.setState('k', 'v', 'proj'));

    expect(fired).toBe(true);
  });

  it('the local adapter is microtask-only, so the wave yield stays load-bearing', async () => {
    // The local adapter wraps SYNCHRONOUS bun:sqlite in an async signature, so
    // its promises settle as microtasks and never reach libuv on their own —
    // the same shape the control starves on. That is not a regression: the
    // work was synchronous before the port too. It means the `setImmediate`
    // between waves (phase-loop.ts:1513) remains the mechanism that keeps the
    // timer phase alive, and must not be removed as redundant.
    const syncBacked = serializeRunStore({
      setState: async () => { /* synchronous work, async signature */ },
    } as unknown as RunStore);

    expect(await timerFiresDuring(() => syncBacked.setState('k', 'v', 'proj'))).toBe(false);

    // With the wave yield in place, the same store lets the timer through.
    const withWaveYield = () => syncBacked.setState('k', 'v', 'proj')
      .then(() => new Promise<void>((resolve) => { setImmediate(resolve); }));

    expect(await timerFiresDuring(withWaveYield)).toBe(true);
  });

  it('serialization itself does not remove the yield', async () => {
    // Unserialized and serialized must agree: the wrapper adds ordering, and
    // must not convert a yielding store into a starving one.
    const bare = await timerFiresDuring(() => yieldingStore.setState('k', 'v', 'proj'));
    const wrapped = await timerFiresDuring(
      () => serializeRunStore(yieldingStore).setState('k', 'v', 'proj'),
    );

    expect(wrapped).toBe(bare);
  });
});
