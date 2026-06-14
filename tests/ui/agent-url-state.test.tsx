// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('../../packages/myco/ui/src/components/ui/list-filter-bar', () => ({
  ListFilterBar: ({
    onClear,
    hasActiveFilters,
  }: {
    onClear: () => void;
    hasActiveFilters: boolean;
  }) => (
    <div data-testid="list-filter-bar">
      {hasActiveFilters && <button type="button" onClick={onClear}>Clear</button>}
    </div>
  ),
}));

mock.module('../../packages/myco/ui/src/components/agent/RunList', () => ({
  RunList: ({ onSelectRun }: { onSelectRun: (id: string) => void }) => (
    <button type="button" onClick={() => onSelectRun('run-2')}>Open run</button>
  ),
}));

mock.module('../../packages/myco/ui/src/components/agent/RunDetail', () => ({
  RunDetail: ({ runId }: { runId: string }) => <div data-testid="run-detail">{runId}</div>,
}));

mock.module('../../packages/myco/ui/src/components/agent/ComparisonView', () => ({
  ComparisonView: ({ onOpenRun }: { onOpenRun: (id: string) => void }) => (
    <button type="button" onClick={() => onOpenRun('run-2')}>Open compared run</button>
  ),
}));

mock.module('../../packages/myco/ui/src/components/agent/RunTaskDialog', () => ({
  RunTaskDialog: () => null,
}));

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentTasks: () => ({ data: { tasks: [] }, isLoading: false }),
  useRunsByIds: () => ({ runs: [], isLoading: false, isError: false, errors: [] }),
  useTask: () => ({ data: null, isLoading: false }),
  useCreateTask: () => ({ mutate: () => {}, isPending: false }),
  useCopyTask: () => ({ mutate: () => {}, isPending: false }),
  useDeleteTask: () => ({ mutate: () => {}, isPending: false }),
  useTaskYaml: () => ({ data: null, isLoading: false }),
  useUpdateTask: () => ({ mutate: () => {}, isPending: false }),
  useTriggerRun: () => ({ mutate: () => {}, isPending: false }),
  useResumeRun: () => ({ mutate: () => {}, isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

import Agent from '../../packages/myco/ui/src/pages/Agent';

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
          <Route path="/g/:groveSlug/p/:projectSlug/agent" element={<><Agent /><LocationProbe /></>} />
          <Route path="/g/:groveSlug/p/:projectSlug/agent/:id" element={<><Agent /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Agent URL state', () => {
  it('preserves run-list search, filters, and pagination when selecting a run', async () => {
    renderPage('/g/default/p/app/agent?status=failed&task=vault-evolve&offset=20&q=canopy');
    fireEvent.click(screen.getByRole('button', { name: 'Open run' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent)
        .toBe('/g/default/p/app/agent/run-2?status=failed&task=vault-evolve&offset=20&q=canopy');
    });
  });

  it('drops comparison params when opening a single run from comparisons', async () => {
    renderPage('/g/default/p/app/agent?tab=comparisons&runs=run-1,run-2');
    fireEvent.click(screen.getByRole('button', { name: 'Open compared run' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/g/default/p/app/agent/run-2');
    });
  });

  it('clears run-list search, filters, and pagination without dropping the selected run path', async () => {
    renderPage('/g/default/p/app/agent/run-1?status=failed&task=vault-evolve&offset=20&q=canopy');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => {
      expect(screen.getByTestId('location').textContent).toBe('/g/default/p/app/agent/run-1');
    });
  });
});
