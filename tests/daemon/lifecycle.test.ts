import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRegistry } from '@myco/daemon/lifecycle';

describe('SessionRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('registers and unregisters sessions', () => {
    const onEmpty = vi.fn();
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty });

    registry.register('s1');
    expect(registry.sessions).toEqual(['s1']);

    registry.register('s2');
    expect(registry.sessions).toEqual(['s1', 's2']);

    registry.unregister('s1');
    expect(registry.sessions).toEqual(['s2']);
  });

  it('starts grace timer when last session unregisters', () => {
    const onEmpty = vi.fn();
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty });

    registry.register('s1');
    registry.unregister('s1');

    expect(onEmpty).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(onEmpty).toHaveBeenCalledOnce();
  });

  it('cancels grace timer if new session registers', () => {
    const onEmpty = vi.fn();
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty });

    registry.register('s1');
    registry.unregister('s1');

    vi.advanceTimersByTime(15_000);
    registry.register('s2');

    vi.advanceTimersByTime(30_000);
    expect(onEmpty).not.toHaveBeenCalled();
  });

  it('does not double-register same session', () => {
    const onEmpty = vi.fn();
    const registry = new SessionRegistry({ gracePeriod: 30, onEmpty });

    registry.register('s1');
    registry.register('s1');
    expect(registry.sessions).toEqual(['s1']);
  });
});
