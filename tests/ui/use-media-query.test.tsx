// @vitest-environment jsdom

import { describe, it, expect, mock, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '../../packages/myco/ui/src/hooks/use-media-query';

type Listener = (e: MediaQueryListEvent) => void;

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initialMatches,
    media: '',
    onchange: null,
    addEventListener: (_type: 'change', listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: 'change', listener: Listener) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  // @ts-expect-error — test scaffold
  globalThis.window.matchMedia = mock((q: string) => ({ ...mql, media: q }));
  return {
    fire(matches: boolean) {
      mql.matches = matches;
      for (const l of listeners) l({ matches } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  // jsdom defines window.matchMedia as non-configurable once assigned, so
  // reset rather than delete.
  // @ts-expect-error — test scaffold
  globalThis.window.matchMedia = undefined;
});

describe('useMediaQuery', () => {
  it('returns the initial match value', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(true);
  });

  it('updates when the matchMedia listener fires', () => {
    const ctl = installMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(result.current).toBe(false);
    act(() => { ctl.fire(true); });
    expect(result.current).toBe(true);
  });

  it('unsubscribes on unmount', () => {
    const ctl = installMatchMedia(true);
    const { unmount } = renderHook(() => useMediaQuery('(min-width: 768px)'));
    expect(ctl.listenerCount()).toBe(1);
    unmount();
    expect(ctl.listenerCount()).toBe(0);
  });
});
