import { describe, it, expect } from 'bun:test';
import { ActionInflightRegistry } from '@myco/daemon/api/action-inflight';

describe('ActionInflightRegistry', () => {
  it('coalesces concurrent runs with the same key', async () => {
    const registry = new ActionInflightRegistry();
    let calls = 0;
    let resolveFn: (v: number) => void = () => {};
    const factory = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        resolveFn = resolve;
      });

    const a = registry.run('k', factory);
    const b = registry.run('k', factory);
    expect(calls).toBe(1);
    expect(registry.has('k')).toBe(true);

    resolveFn(7);
    const [aRes, bRes] = await Promise.all([a, b]);
    expect(aRes).toBe(7);
    expect(bRes).toBe(7);
    expect(registry.has('k')).toBe(false);
  });

  it('runs separate keys independently', async () => {
    const registry = new ActionInflightRegistry();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return calls;
    };

    const a = await registry.run('k1', factory);
    const b = await registry.run('k2', factory);
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it('releases the slot on rejection', async () => {
    const registry = new ActionInflightRegistry();
    let attempts = 0;
    const factory = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(registry.run('k', factory)).rejects.toThrow('boom');
    expect(registry.has('k')).toBe(false);
    const second = await registry.run('k', factory);
    expect(second).toBe('ok');
  });
});
