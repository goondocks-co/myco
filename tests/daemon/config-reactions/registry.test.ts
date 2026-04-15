import { describe, it, expect, vi } from 'vitest';
import { createConfigReactionRegistry } from '@myco/daemon/config-reactions/registry.js';
import type { MycoConfig } from '@myco/config/schema.js';

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Reactions accept a MycoConfig ctx but most of these tests don't read it.
// A bare cast keeps the fixtures small; the few tests that care about the
// value cast a literal into MycoConfig directly.
const ctx = {} as MycoConfig;

describe('ConfigReactionRegistry', () => {
  it('fires reaction when touched path matches registered prefix', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['capture'], fn);
    await r.fire(['capture.plan_dirs'], ctx);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not fire when registered prefix does not match', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['capture'], fn);
    await r.fire(['daemon.log_level'], ctx);
    expect(fn).not.toHaveBeenCalled();
  });

  it('treats empty prefix list as "fire always"', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on([], fn);
    await r.fire(['anything.at.all'], ctx);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('fires on exact prefix match (path === prefix)', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['daemon.log_level'], fn);
    await r.fire(['daemon.log_level'], ctx);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not match sibling paths that share a prefix substring', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['daemon.log_level'], fn);
    await r.fire(['daemon.log_level_details'], ctx);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires when any registered prefix matches any touched path', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['capture', 'daemon.log_level'], fn);
    await r.fire(['daemon.log_level'], ctx);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('runs reactions in registration order', async () => {
    const order: number[] = [];
    const r = createConfigReactionRegistry(makeLogger());
    r.on([], () => { order.push(1); });
    r.on([], () => { order.push(2); });
    r.on([], () => { order.push(3); });
    await r.fire(['x'], ctx);
    expect(order).toEqual([1, 2, 3]);
  });

  it('awaits async reactions', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    let done = false;
    r.on([], async () => {
      await new Promise((res) => setTimeout(res, 5));
      done = true;
    });
    await r.fire(['x'], ctx);
    expect(done).toBe(true);
  });

  it('passes the merged config to each reaction', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    const sharedCtx = { daemon: { log_level: 'debug' } } as unknown as MycoConfig;
    r.on([], fn);
    await r.fire(['daemon.log_level'], sharedCtx);
    expect(fn).toHaveBeenCalledWith(sharedCtx);
  });

  it('logs and continues when a reaction throws', async () => {
    const logger = makeLogger();
    const r = createConfigReactionRegistry(logger);
    const after = vi.fn();
    r.on([], () => { throw new Error('boom'); });
    r.on([], after);
    await r.fire(['x'], ctx);
    expect(after).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith('config-reactions', expect.any(String), expect.objectContaining({ error: expect.stringContaining('boom') }));
  });

  it('fires nothing when touched paths is empty and no empty-prefix reactions', async () => {
    const r = createConfigReactionRegistry(makeLogger());
    const fn = vi.fn();
    r.on(['capture'], fn);
    await r.fire([], ctx);
    expect(fn).not.toHaveBeenCalled();
  });
});
