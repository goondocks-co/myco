// @vitest-environment jsdom

/**
 * Phase 7 Block 6 T29 — Mycelium page-level TileTabs contract.
 *
 * Asserts the two Mycelium tabs (Graph / Spores) render via TileTabs with
 * v7 descriptors and active state tracks the URL.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Stub the heavy GraphTab / Spore components so we focus only on tab chrome.
mock.module('../../packages/myco/ui/src/components/mycelium/GraphCanvas', () => ({
  GraphCanvas: () => <div data-testid="graph-canvas" />,
}));
mock.module('../../packages/myco/ui/src/components/mycelium/Inspector', () => ({
  Inspector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/mycelium/SporeList', () => ({
  SporeList: () => <div data-testid="spore-list" />,
}));
mock.module('../../packages/myco/ui/src/components/mycelium/SporeDetail', () => ({
  SporeDetail: () => <div data-testid="spore-detail" />,
}));

mock.module('../../packages/myco/ui/src/hooks/use-spores', () => ({
  useFullGraph: () => ({ data: { nodes: [], edges: [] }, isLoading: false }),
  useGraph: () => ({ data: null, isLoading: false }),
  useGraphSeeds: () => ({ data: { recommended_id: null, seeds: [] }, isLoading: false }),
}));

import Mycelium from '../../packages/myco/ui/src/pages/Mycelium';

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/mycelium" element={<Mycelium />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Mycelium page TileTabs (T27)', () => {
  it('renders Graph + Spores tabs with descriptors', () => {
    renderPage('/mycelium');
    const labels = screen.getAllByRole('tab').map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.includes('Graph'))).toBe(true);
    expect(labels.some((l) => l.includes('Spores'))).toBe(true);
    expect(labels.some((l) => l.includes('connection map'))).toBe(true);
    expect(labels.some((l) => l.includes('captured knowledge'))).toBe(true);
  });

  it('marks Graph active by default', () => {
    renderPage('/mycelium');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Graph');
  });
});
