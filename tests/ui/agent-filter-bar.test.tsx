// @vitest-environment jsdom

// SPDX-License-Identifier: Apache-2.0

/**
 * Agent page-level filter bar contract.
 *
 * Mirrors the Sessions page contract: run search/filter chrome lives above the
 * master/detail split, while <RunList> receives the effective query state.
 */

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const agentRunsQueryMock = mock<(opts: Record<string, unknown>) => void>(() => {});

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

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentRuns: (opts: Record<string, unknown>) => {
    agentRunsQueryMock(opts);
    return { data: { runs: [], total: 0, offset: 0, limit: 20 }, isLoading: false, isError: false };
  },
  useAgentRun: () => ({ data: null, isLoading: false, isError: false }),
  useAgentReports: () => ({ data: { reports: [] }, isLoading: false }),
  useAgentTurns: () => ({ data: [], isLoading: false }),
  useAgentTasks: () => ({
    data: {
      tasks: [
        { name: 'canopy-describe', displayName: 'Canopy Describe' },
        { name: 'vault-evolve', displayName: 'Vault Evolve' },
      ],
    },
    isLoading: false,
  }),
  useTask: () => ({ data: null, isLoading: false }),
  useCreateTask: () => ({ mutate: () => {}, isPending: false }),
  useCopyTask: () => ({ mutate: () => {}, isPending: false }),
  useDeleteTask: () => ({ mutate: () => {}, isPending: false }),
  useTaskYaml: () => ({ data: null, isLoading: false }),
  useUpdateTask: () => ({ mutate: () => {}, isPending: false }),
  useTriggerRun: () => ({ mutate: () => {}, isPending: false }),
  useResumeRun: () => ({ mutate: () => {}, isPending: false }),
  useRunsByIds: () => ({ runs: [], isLoading: false, isError: false, errors: [] }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

mock.module('../../packages/myco/ui/src/components/agent/RunTaskDialog', () => ({
  RunTaskDialog: () => null,
}));

import Agent from '../../packages/myco/ui/src/pages/Agent';

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/agent" element={<Agent />} />
          <Route path="/agent/:id" element={<Agent />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Agent page-level filter bar', () => {
  it('renders <ListFilterBar> outside the master/detail split', async () => {
    const { container } = renderPage('/agent');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar')).toBeTruthy());
    const filterBar = container.querySelector('[data-testid="list-filter-bar"]') as HTMLElement;
    const masterDetail = container.querySelector('[role="region"][aria-label="Agent runs"]')
      ?? container.querySelector('[aria-label="Agent runs"]');
    expect(filterBar).toBeTruthy();
    expect(masterDetail).toBeTruthy();
    expect(masterDetail!.contains(filterBar)).toBe(false);
  });

  it('passes status + task filters into the bar', async () => {
    renderPage('/agent');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar')).toBeTruthy());
    const bar = screen.getByTestId('list-filter-bar');
    expect(bar.getAttribute('data-filter-count')).toBe('2');
    expect(screen.getByTestId('filter-status').textContent).toBe('Status');
    expect(screen.getByTestId('filter-task').textContent).toBe('Task');
  });

  it('threads search input through to useAgentRuns as the `search` query option', async () => {
    renderPage('/agent');
    await waitFor(() => expect(screen.getByTestId('list-filter-bar-search')).toBeTruthy());
    const input = screen.getByTestId('list-filter-bar-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'canopy' } });
    await waitFor(() => {
      const calls = agentRunsQueryMock.mock.calls;
      const latest = calls[calls.length - 1]?.[0] as Record<string, unknown> | undefined;
      expect(latest?.search).toBe('canopy');
    });
  });

  it('passes active clear state into the shared filter bar', async () => {
    renderPage('/agent?status=completed');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy());
  });
});
