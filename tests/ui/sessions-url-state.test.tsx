// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('../../packages/myco/ui/src/components/ui/list-filter-bar', () => ({
  ListFilterBar: ({
    onFilterChange,
    onClear,
    hasActiveFilters,
  }: {
    onFilterChange: (key: string, value: string) => void;
    onClear: () => void;
    hasActiveFilters: boolean;
  }) => (
    <div data-testid="list-filter-bar">
      <button type="button" onClick={() => onFilterChange('agent', 'all')}>All agents</button>
      {hasActiveFilters && <button type="button" onClick={onClear}>Clear</button>}
    </div>
  ),
}));

mock.module('../../packages/myco/ui/src/components/sessions/SessionList', () => ({
  SessionList: ({
    onSelectSession,
  }: {
    onSelectSession: (id: string, options?: { replace?: boolean }) => void;
  }) => (
    <div data-testid="session-list">
      <button type="button" onClick={() => onSelectSession('sess-2')}>Open session</button>
    </div>
  ),
}));

mock.module('../../packages/myco/ui/src/components/sessions/SessionDetail', () => ({
  SessionDetail: ({ id }: { id: string }) => <div data-testid="session-detail">{id}</div>,
}));

mock.module('../../packages/myco/ui/src/hooks/use-symbionts', () => ({
  useSymbionts: () => ({ data: { symbionts: [] } }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

import Sessions from '../../packages/myco/ui/src/pages/Sessions';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/g/:groveSlug/p/:projectSlug/sessions" element={<><Sessions /><LocationProbe /></>} />
          <Route path="/g/:groveSlug/p/:projectSlug/sessions/:id" element={<><Sessions /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Sessions URL state', () => {
  it('preserves list search, filters, and pagination when selecting a session', async () => {
    renderPage('/g/default/p/app/sessions?agent=codex&status=active&offset=20&q=plan');
    fireEvent.click(screen.getByRole('button', { name: 'Open session' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent)
        .toBe('/g/default/p/app/sessions/sess-2?agent=codex&status=active&offset=20&q=plan');
    });
  });

  it('preserves detail params when list filters change', async () => {
    renderPage('/g/default/p/app/sessions/sess-1?tab=plans&plan=p1&agent=codex&offset=20');
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent)
        .toBe('/g/default/p/app/sessions/sess-1?tab=plans&plan=p1');
    });
  });

  it('clears search, filters, and pagination without dropping selected detail params', async () => {
    renderPage('/g/default/p/app/sessions/sess-1?tab=plans&plan=p1&agent=codex&status=active&offset=20&q=plan');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent)
        .toBe('/g/default/p/app/sessions/sess-1?tab=plans&plan=p1');
    });
  });
});
