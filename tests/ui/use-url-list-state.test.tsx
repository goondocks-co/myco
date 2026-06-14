// @vitest-environment jsdom

import { describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';
import { FILTER_ALL } from '../../packages/myco/ui/src/hooks/use-list-filters';
import { useUrlListState } from '../../packages/myco/ui/src/hooks/use-url-list-state';

mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

function wrapper(initial: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: [initial] }, children);
  };
}

function useHarness() {
  const location = useLocation();
  const state = useUrlListState({
    filters: [
      { key: 'status', defaultValue: FILTER_ALL },
      { key: 'agent', defaultValue: FILTER_ALL },
    ],
  });
  return { location, state };
}

describe('useUrlListState', () => {
  it('hydrates filter, search, and offset state from the URL', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: wrapper('/sessions?agent=codex&q=plan&offset=20'),
    });
    expect(result.current.state.filterValues.agent).toBe('codex');
    expect(result.current.state.searchInput).toBe('plan');
    expect(result.current.state.debouncedSearch).toBe('plan');
    expect(result.current.state.offset).toBe(20);
  });

  it('filter changes reset offset and preserve unrelated detail params', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: wrapper('/sessions/s1?tab=plans&plan=p1&agent=codex&offset=20'),
    });
    act(() => result.current.state.handleFilterChange('agent', FILTER_ALL));
    expect(result.current.location.pathname).toBe('/sessions/s1');
    expect(result.current.location.search).toBe('?tab=plans&plan=p1');
  });

  it('page changes update only offset', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: wrapper('/sessions?agent=codex'),
    });
    act(() => result.current.state.setOffset(40));
    expect(result.current.location.search).toBe('?agent=codex&offset=40');
  });

  it('search changes reset offset and preserve unrelated params', () => {
    const { result } = renderHook(() => useHarness(), {
      wrapper: wrapper('/sessions/s1?tab=plans&plan=p1&offset=20'),
    });
    act(() => result.current.state.handleSearchChange('vault'));
    expect(result.current.location.search).toBe('?tab=plans&plan=p1&q=vault');
  });
});
