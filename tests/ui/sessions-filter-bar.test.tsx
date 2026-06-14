// @vitest-environment jsdom

/**
 * Phase 7 Block 2 T15 — Sessions page-level filter bar contract.
 *
 * Asserts the filter chrome was correctly lifted out of `<SessionList>` and
 * now lives at the page level (above MasterDetailSplit), so the master pane
 * reclaims its full width and the search/filter wiring drives the underlying
 * `useSessions` query.
 *
 * Why we stub <ListFilterBar>: pulling Radix Select through bun's
 * isolated jsdom render trips an "Invalid hook call" — captured as a Block 1
 * spore. This test mocks the primitive to a plain `<input>` wrapper so we can
 * still assert structural placement + search wiring deterministically. The
 * primitive's tone/filter rendering is covered by component-level tests; the
 * full Radix interaction will get exercised in dogfood + real-browser CI when
 * the dev UI loads the page.
 */

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const sessionsQueryMock = mock<(opts: Record<string, unknown>) => void>(() => {});

mock.module('../../packages/myco/ui/src/components/ui/list-filter-bar', () => {
  return {
    ListFilterBar: ({
      searchValue,
      onSearchChange,
      filters,
      searchPlaceholder,
      onClear,
      hasActiveFilters,
    }: {
      searchValue: string;
      onSearchChange: (v: string) => void;
      filters?: Array<{ key: string; label: string }>;
      searchPlaceholder?: string;
      onClear?: () => void;
      hasActiveFilters?: boolean;
    }) => (
      <div data-testid="list-filter-bar" data-filter-count={filters?.length ?? 0}>
        <input
          data-testid="list-filter-bar-search"
          placeholder={searchPlaceholder}
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {filters?.map((f) => (
          <span key={f.key} data-testid={`filter-${f.key}`}>
            {f.label}
          </span>
        ))}
        {hasActiveFilters && <button type="button" onClick={onClear}>Clear</button>}
      </div>
    ),
  };
});

// Sessions hook fixture — records what query options it was called with so
// the test can assert wiring without a real network round-trip. The debounced
// search will eventually arrive on a follow-up render.
mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessions: (opts: Record<string, unknown>) => {
    sessionsQueryMock(opts);
    return { data: { sessions: [], total: 0 }, isLoading: false, isError: false };
  },
  useDeleteSession: () => ({ mutate: () => {}, isPending: false, isSuccess: false }),
  useSessionImpact: () => ({ data: undefined }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-symbionts', () => ({
  useSymbionts: () => ({
    data: {
      symbionts: [
        { name: 'claude-code', displayName: 'Claude Code', enabled: true },
        { name: 'cursor', displayName: 'Cursor', enabled: true },
      ],
    },
  }),
}));

// Force the debounced value through immediately so the test can drive the
// search wiring without sleeping.
mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

// Import the page AFTER the mocks so it sees the stubbed modules.
import Sessions from '../../packages/myco/ui/src/pages/Sessions';

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<Sessions />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sessions page-level filter bar (T12)', () => {
  it('renders <ListFilterBar> outside the master/detail split', async () => {
    const { container } = renderPage('/sessions');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar')).toBeTruthy());
    const filterBar = container.querySelector('[data-testid="list-filter-bar"]') as HTMLElement;
    const masterDetail = container.querySelector('[role="region"][aria-label="Sessions"]')
      ?? container.querySelector('[aria-label="Sessions"]');
    expect(filterBar).toBeTruthy();
    expect(masterDetail).toBeTruthy();
    // Structural contract: the filter bar must NOT be a descendant of the
    // master pane — the whole point of T12 is to lift it out so the master
    // pane reclaims its width.
    expect(masterDetail!.contains(filterBar)).toBe(false);
  });

  it('passes status + symbiont + plans filters into the bar', async () => {
    renderPage('/sessions');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar')).toBeTruthy());
    const bar = screen.getByTestId('list-filter-bar');
    expect(bar.getAttribute('data-filter-count')).toBe('3');
    expect(screen.getByTestId('filter-status').textContent).toBe('Status');
    expect(screen.getByTestId('filter-agent').textContent).toBe('Symbiont');
    expect(screen.getByTestId('filter-has_plan').textContent).toBe('Plans');
  });

  it('threads search input through to useSessions as the `search` query option', async () => {
    renderPage('/sessions');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar-search')).toBeTruthy());
    const input = screen.getByTestId('list-filter-bar-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'onboarding' } });
    await waitFor(() => {
      const calls = sessionsQueryMock.mock.calls;
      // Latest call should have search === 'onboarding'
      const latest = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
      expect(latest?.search).toBe('onboarding');
    });
  });

  it('passes active clear state into the shared filter bar', async () => {
    renderPage('/sessions?agent=codex');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
  });
});
