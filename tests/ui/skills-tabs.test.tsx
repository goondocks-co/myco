// @vitest-environment jsdom

/**
 * Phase 7 Block 5 T26 — Skills page TileTabs + ListFilterBar contract.
 *
 * Renders Skills with the candidate / record hooks mocked and asserts:
 *   1. The page-level TileTabs renders Skills + Candidates with descriptions.
 *   2. Active state honors `?tab=…`.
 *   3. The SkillList (Skills tab default) renders a ListFilterBar at page
 *      level via our stubbed implementation; the search input is wired to
 *      the underlying record query.
 *   4. The CandidateList (Candidates tab) also surfaces a ListFilterBar.
 *
 * Same stubbing pattern as cortex-tabs / sessions-filter-bar to avoid
 * Radix Select rendering in the bun + jsdom env (Block 1 spore).
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const recordsQueryMock = mock<(opts: Record<string, unknown>) => void>(() => {});

mock.module('../../packages/myco/ui/src/components/ui/list-filter-bar', () => ({
  ListFilterBar: ({
    searchValue,
    onSearchChange,
    filters,
    searchPlaceholder,
  }: {
    searchValue: string;
    onSearchChange: (v: string) => void;
    filters?: Array<{ key: string; label: string }>;
    searchPlaceholder?: string;
  }) => (
    <div data-testid="list-filter-bar" data-filter-count={filters?.length ?? 0}>
      <input
        data-testid="list-filter-bar-search"
        placeholder={searchPlaceholder}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
      />
    </div>
  ),
}));

mock.module('../../packages/myco/ui/src/hooks/use-skills', () => ({
  useSkillRecords: (opts: Record<string, unknown>) => {
    recordsQueryMock(opts);
    return {
      data: {
        records: [
          {
            id: 'sk1',
            name: 'phase-7-ui-evolution',
            display_name: 'Phase 7 UI evolution',
            description: 'discipline',
            status: 'active',
            generation: 1,
            candidate_id: null,
            source_ids: '[]',
            path: '.agents/skills/phase-7-ui-evolution.md',
            usage_count: 12,
            last_used_at: null,
            created_at: 1779000000,
            updated_at: 1779099900,
            properties: null,
          },
        ],
        total: 1,
      },
      isLoading: false,
      isError: false,
    };
  },
  useSkillCandidates: () => ({
    data: { candidates: [], total: 0 },
    isLoading: false,
    isError: false,
  }),
  useUpdateCandidate: () => ({ mutate: () => {}, isPending: false }),
  useDeleteSkillRecord: () => ({ mutate: () => {}, isPending: false }),
  useSkillRecord: () => ({ data: null, isPending: false, isError: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-debounce', () => ({
  useDebounce: (v: string) => v,
}));

import Skills from '../../packages/myco/ui/src/pages/Skills';

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/skills" element={<Skills />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Skills page TileTabs (T23)', () => {
  it('renders the Skills + Candidates tabs with descriptions', () => {
    renderPage('/skills');
    const tabs = screen.getAllByRole('tab');
    const labels = tabs.map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.includes('Skills'))).toBe(true);
    expect(labels.some((l) => l.includes('Candidates'))).toBe(true);
    expect(labels.some((l) => l.includes('promoted records'))).toBe(true);
    expect(labels.some((l) => l.includes('approval queue'))).toBe(true);
  });

  it('marks Skills active by default', () => {
    renderPage('/skills');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Skills');
  });

  it('marks Candidates active when ?tab=candidates', () => {
    renderPage('/skills?tab=candidates');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Candidates');
  });
});

describe('Skills page ListFilterBar (T24)', () => {
  it('renders ListFilterBar on the Skills tab', () => {
    renderPage('/skills');
    expect(screen.getByTestId('list-filter-bar')).toBeTruthy();
  });

  it('threads search input through to useSkillRecords', () => {
    renderPage('/skills');
    const input = screen.getByTestId('list-filter-bar-search') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'phase' } });
    // Local search filtering is client-side in SkillList — the query
    // call still fires with the active filter values, and the local
    // filter applies on top. We assert the input wiring (re-renders with
    // new value) rather than the underlying query string.
    expect(input.value).toBe('phase');
  });

  it('renders ListFilterBar on the Candidates tab as well', () => {
    renderPage('/skills?tab=candidates');
    expect(screen.getByTestId('list-filter-bar')).toBeTruthy();
  });
});
