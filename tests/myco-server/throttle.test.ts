import { describe, it, expect } from 'bun:test';
import { createIngestThrottle } from './helpers/throttle.js';

describe('ingest throttle', () => {
  it('allows to the limit then refuses', async () => {
    const t = createIngestThrottle(2, 1_000, 100, () => 0);
    expect((await t.limit({ key: 'k' })).success).toBe(true);
    expect((await t.limit({ key: 'k' })).success).toBe(true);
    expect((await t.limit({ key: 'k' })).success).toBe(false);
  });

  it('recovers after the window', async () => {
    let now = 0;
    const t = createIngestThrottle(1, 1_000, 100, () => now);
    await t.limit({ key: 'k' });
    expect((await t.limit({ key: 'k' })).success).toBe(false);
    now = 1_001;
    expect((await t.limit({ key: 'k' })).success).toBe(true);
  });

  it('counts every call, so a success never clears the budget', async () => {
    const t = createIngestThrottle(2, 1_000, 100, () => 0);
    await t.limit({ key: 'k' });
    await t.limit({ key: 'k' });
    expect((await t.limit({ key: 'k' })).success).toBe(false);
  });

  it('bounds its key space under attacker-chosen keys', async () => {
    const t = createIngestThrottle(5, 60_000, 10, () => 0);
    for (let i = 0; i < 1_000; i++) await t.limit({ key: `k${i}` });
    expect(t.size()).toBeLessThanOrEqual(10);
  });

  it('keeps a limited key limited while junk keys flood the map', async () => {
    const t = createIngestThrottle(1, 60_000, 10, () => 0);
    await t.limit({ key: 'k' });
    expect((await t.limit({ key: 'k' })).success).toBe(false);
    for (let i = 0; i < 1_000; i++) await t.limit({ key: `junk${i}` });
    expect((await t.limit({ key: 'k' })).success).toBe(false);
  });

  it('refuses a new key at capacity until an old key expires', async () => {
    let now = 0;
    const t = createIngestThrottle(5, 1_000, 2, () => now);
    await t.limit({ key: 'a' });
    await t.limit({ key: 'b' });
    expect((await t.limit({ key: 'c' })).success).toBe(false);
    now = 1_001;
    expect((await t.limit({ key: 'c' })).success).toBe(true);
  });

  it('holds constant memory per key however many calls arrive', async () => {
    const t = createIngestThrottle(2, 60_000, 10, () => 0);
    for (let i = 0; i < 100_000; i++) await t.limit({ key: 'k' });
    expect((await t.limit({ key: 'k' })).success).toBe(false);
    expect(t.size()).toBe(1);
  });
});
