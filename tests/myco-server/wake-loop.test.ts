/**
 * The self-hosted wake loop: one timer, re-armed from the tick's answer,
 * bounded by a floor, brought forward by `ensure`, and quiet after `stop`.
 */
import { describe, expect, it } from 'bun:test';
import { startWakeLoop } from '@myco-server-worker/platform/bun/wake-loop.js';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the wake loop', () => {
  it('ticks at once, then at the delay the tick names, never later than the floor', async () => {
    const ticks: number[] = [];
    const answers = [20, 5_000, null];
    const loop = startWakeLoop(async () => { ticks.push(Date.now()); return { nextWakeMs: answers.shift() ?? null }; }, { floorMs: 60 });
    await settle(15);
    expect(ticks).toHaveLength(1);
    await settle(30);
    expect(ticks).toHaveLength(2);
    // The second tick asked for five seconds; the floor of sixty milliseconds wakes first.
    await settle(80);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    loop.stop();
  });

  it('wakes soon on ensure unless a wake is already due sooner, and runs a tick that arrived mid-tick once more', async () => {
    let ticks = 0;
    let release: () => void = () => {};
    const loop = startWakeLoop(async () => {
      ticks += 1;
      if (ticks === 1) await new Promise<void>((resolve) => { release = resolve; });
      return { nextWakeMs: 10_000 };
    }, { floorMs: 10_000, soonMs: 5 });
    await settle(5);
    expect(ticks).toBe(1);
    await loop.ensure();
    await settle(20);
    // The first tick is still running; the ensure is remembered, not lost.
    expect(ticks).toBe(1);
    release();
    await settle(20);
    expect(ticks).toBe(2);
    loop.stop();
  });

  it('runs nothing after stop', async () => {
    let ticks = 0;
    const loop = startWakeLoop(async () => { ticks += 1; return { nextWakeMs: 5 }; }, { floorMs: 5 });
    await settle(12);
    loop.stop();
    const seen = ticks;
    await settle(30);
    expect(ticks).toBe(seen);
  });

  it('stop resolves only once a tick already running has returned, and starts no other', async () => {
    let ticks = 0;
    let release: () => void = () => {};
    let returned = false;
    const loop = startWakeLoop(async () => {
      ticks += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      returned = true;
      return { nextWakeMs: 0 };
    }, { floorMs: 5 });
    await settle(5);
    expect(ticks).toBe(1);
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await settle(10);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect({ returned, stopped }).toEqual({ returned: true, stopped: true });
    await settle(20);
    expect(ticks).toBe(1);
  });

  it('backs failures off within a bound, holds ensure at that deadline, and resets after success', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const realNow = Date.now;
    let now = 1_000_000;
    let timer: { callback: () => void; at: number } | null = null;
    let ticks = 0;
    let fails = true;
    globalThis.setTimeout = ((callback: () => void, delay: number) => { timer = { callback, at: now + delay }; return 1; }) as typeof setTimeout;
    globalThis.clearTimeout = (() => { timer = null; }) as typeof clearTimeout;
    Date.now = () => now;
    const loop = startWakeLoop(async () => {
      ticks++;
      if (fails) throw new Error('fixture tick failure');
      return { nextWakeMs: 300_000 };
    }, { floorMs: 900_000 });
    const advance = async () => {
      const pending = timer!;
      now = pending.at;
      timer = null;
      pending.callback();
      await new Promise<void>(resolve => { realSetTimeout(resolve, 0); });
    };
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        await advance();
        const at = now + Math.min(30_000 * 2 ** attempt, 300_000);
        expect(timer!.at).toBe(at);
        await loop.ensure();
        expect(timer!.at).toBe(at);
      }
      fails = false;
      await advance();
      await loop.ensure();
      expect(timer!.at).toBe(now + 1_000);
      expect(ticks).toBe(9);
    } finally {
      await loop.stop();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      Date.now = realNow;
    }
  });
});
