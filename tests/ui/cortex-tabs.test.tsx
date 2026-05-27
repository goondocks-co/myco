// @vitest-environment jsdom

/**
 * Phase 7 Block 4 T22 — Cortex page-level tabs + Canopy sub-tabs contract.
 *
 * Renders the Cortex page with the four hooks Cortex.tsx pulls from mocked
 * (useScopedConfig, useAgentRuns, useAgentTasks, useSymbionts) and asserts:
 *   1. The page-level TileTabs renders all 4 Cortex tabs (Instructions /
 *      Builder / Digest / Canopy), driven by URL.
 *   2. Active state honors the `?tab=…` URL parameter.
 *   3. The Canopy SubtabPill renders Overview / Entries / Map when
 *      activeTab=canopy.
 *
 * We don't drive the InstructionsTab/Builder/Digest internals here — those
 * are exercised in their own focused tests. The contract this block is
 * shipping is the tab chrome itself.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: {
      agent: { tasks: {} },
      cortex: { canopy: {}, instructions: {}, digest: {}, spores: {} },
    },
    isLoading: false,
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentRuns: () => ({ data: { runs: [], total: 0, offset: 0, limit: 12 }, isLoading: false, isFetching: false, refetch: () => {} }),
  useAgentTasks: () => ({ data: { tasks: [] }, isLoading: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-symbionts', () => ({
  useSymbionts: () => ({
    data: { symbionts: [{ name: 'claude-code', displayName: 'Claude Code', enabled: true }] },
  }),
}));

// Stub the canopy panels so they don't pull canopy-entries hooks (those
// require additional mocking that isn't relevant to the tab-chrome contract).
mock.module('../../packages/myco/ui/src/components/canopy/CanopyEntriesPanel', () => ({
  CanopyEntriesPanel: () => <div data-testid="canopy-entries-panel" />,
}));
mock.module('../../packages/myco/ui/src/components/canopy/CanopyMapPanel', () => ({
  CanopyMapPanel: () => <div data-testid="canopy-map-panel" />,
}));

// DigestView pulls a digest fetch; stub it.
mock.module('../../packages/myco/ui/src/components/mycelium/DigestView', () => ({
  DigestView: () => <div data-testid="digest-view" />,
}));

// useQuery is used directly inside InstructionsTab for cortex-instructions.
// We avoid bringing in real fetch by stubbing the api module.
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async () => ({
    content: '## Myco-Enabled Project\n\nStored instructions text.',
    generatedAt: null,
    sourceRunId: null,
    enabled: false,
    stored: true,
  }),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
}));

import Cortex from '../../packages/myco/ui/src/pages/Cortex';

function renderPage(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/cortex" element={<Cortex />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Cortex page-level TileTabs (T19)', () => {
  it('renders all four Cortex tabs', () => {
    renderPage('/cortex');
    expect(screen.getByText('Instructions')).toBeTruthy();
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('Digest')).toBeTruthy();
    expect(screen.getByText('Canopy')).toBeTruthy();
  });

  it('marks Instructions active by default', () => {
    renderPage('/cortex');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Instructions');
  });

  it('shows stored instructions expanded by default', async () => {
    renderPage('/cortex');
    expect(await screen.findByText('Collapse')).toBeTruthy();
    expect(await screen.findByText('Myco-Enabled Project')).toBeTruthy();
  });

  it('marks Digest active when ?tab=digest', () => {
    renderPage('/cortex?tab=digest');
    const active = screen.getByRole('tab', { selected: true });
    expect(active.textContent).toContain('Digest');
    expect(screen.getByTestId('digest-view')).toBeTruthy();
  });
});

describe('Cortex Canopy SubtabPill (T20)', () => {
  it('renders Overview / Entries / Map sub-tabs when ?tab=canopy', () => {
    renderPage('/cortex?tab=canopy');
    // SubtabPill renders role=tablist with three role=tab children.
    const allTabs = screen.getAllByRole('tab');
    const labels = allTabs.map((t) => t.textContent ?? '');
    // The Canopy sub-tabs co-exist with the page-level Cortex tabs, so we
    // assert containment rather than equality.
    expect(labels.some((l) => l.includes('Overview'))).toBe(true);
    expect(labels.some((l) => l.includes('Entries'))).toBe(true);
    expect(labels.some((l) => l.includes('Map'))).toBe(true);
  });

  it('shows the Entries panel when ?tab=canopy&section=entries', () => {
    renderPage('/cortex?tab=canopy&section=entries');
    expect(screen.getByTestId('canopy-entries-panel')).toBeTruthy();
  });

  it('shows the Map panel when ?tab=canopy&section=map', () => {
    renderPage('/cortex?tab=canopy&section=map');
    expect(screen.getByTestId('canopy-map-panel')).toBeTruthy();
  });
});
