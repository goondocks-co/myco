// @vitest-environment jsdom

/**
 * Phase 7 Block 6 T29 — Agent page-level TileTabs contract.
 *
 * Asserts the four Agent tabs (Runs / Tasks / Comparisons / Config) render
 * via TileTabs, active state honors the URL, and the tab labels carry
 * their v7 descriptors.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('../../packages/myco/ui/src/components/ui/list-filter-bar', () => ({
  ListFilterBar: () => <div data-testid="list-filter-bar" />,
}));

// Stub data hooks so Agent renders without network.
mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentRuns: () => ({ data: { runs: [], total: 0, offset: 0, limit: 20 }, isLoading: false, isFetching: false, refetch: () => {} }),
  useAgentRun: () => ({ data: null, isLoading: false, isError: false }),
  useAgentReports: () => ({ data: { reports: [] }, isLoading: false }),
  useAgentTurns: () => ({ data: [], isLoading: false }),
  useAgentTasks: () => ({ data: { tasks: [] }, isLoading: false }),
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

// Stub child components that pull additional hooks not relevant to the tab
// chrome contract.
mock.module('../../packages/myco/ui/src/components/agent/RunList', () => ({
  RunList: () => <div data-testid="run-list" />,
}));
mock.module('../../packages/myco/ui/src/components/agent/TaskList', () => ({
  TaskList: () => <div data-testid="task-list" />,
}));
mock.module('../../packages/myco/ui/src/components/agent/AgentConfig', () => ({
  AgentConfig: () => <div data-testid="agent-config" />,
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

describe('Agent page TileTabs (T28)', () => {
  it('renders all four Agent tabs with descriptors', () => {
    renderPage('/agent');
    const labels = screen.getAllByRole('tab').map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.includes('Runs'))).toBe(true);
    expect(labels.some((l) => l.includes('Tasks'))).toBe(true);
    expect(labels.some((l) => l.includes('Comparisons'))).toBe(true);
    expect(labels.some((l) => l.includes('Config'))).toBe(true);
    expect(labels.some((l) => l.includes('execution log'))).toBe(true);
    expect(labels.some((l) => l.includes('agent settings'))).toBe(true);
  });

  it('marks Runs active by default', () => {
    renderPage('/agent');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Runs');
    expect(screen.getByTestId('run-list')).toBeTruthy();
  });

  it('marks Tasks active when ?tab=tasks', () => {
    renderPage('/agent?tab=tasks');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Tasks');
    expect(screen.getByTestId('task-list')).toBeTruthy();
  });

  it('marks Config active when ?tab=config', () => {
    renderPage('/agent?tab=config');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Config');
    expect(screen.getByTestId('agent-config')).toBeTruthy();
  });
});
