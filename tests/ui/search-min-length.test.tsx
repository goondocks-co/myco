// @vitest-environment jsdom
/**
 * RC-11 satellite — the search min-length gate was `query.length > 2`,
 * so a 2-character query (which the UI invites) silently fired nothing.
 * The gate is now `>= SEARCH_MIN_LENGTH` via the shared
 * `meetsSearchMinLength` predicate; these tests pin both the predicate and
 * that a 2-character query actually issues a request.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import { meetsSearchMinLength, useSearch } from '../../packages/myco/ui/src/hooks/use-search';

let fetchMock: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe('search min-length gate (RC-11 satellite)', () => {
  beforeEach(() => {
    fetchMock = vi.fn(() => Promise.resolve(Response.json({ mode: 'semantic', results: [] })));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('meetsSearchMinLength admits 2-character queries and rejects shorter ones', () => {
    expect(meetsSearchMinLength('ab')).toBe(true);
    expect(meetsSearchMinLength('a')).toBe(false);
    expect(meetsSearchMinLength('')).toBe(false);
  });

  it('useSearch fires a request for a 2-character query', async () => {
    renderHook(() => useSearch('ab'), { wrapper: makeWrapper() });

    await waitFor(() => {
      const searchCall = fetchMock.mock.calls.find(([url]: [string | URL | Request]) =>
        String(url).includes('/search?'),
      );
      expect(searchCall).toBeDefined();
      expect(String(searchCall![0])).toContain('q=ab');
    });
  });

  it('useSearch stays idle for a 1-character query', async () => {
    const { result } = renderHook(() => useSearch('a'), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(
      fetchMock.mock.calls.some(([url]: [string | URL | Request]) => String(url).includes('/search?')),
    ).toBe(false);
  });
});
