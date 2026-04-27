// @vitest-environment jsdom

/**
 * Tests the unified Canopy sub-tab on the Cortex page: the secondary nav
 * (Overview | Entries | Map), the legacy `?tab=canopy-entries` /
 * `?tab=project-map` URL aliases that redirect into the new shape, and
 * default-section behavior.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

/* ---------- Mocks ---------- */

const fetchJsonMock = vi.fn();
const postJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
  putJson: vi.fn(),
  deleteJson: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

mock.module('../../packages/myco/ui/src/components/ui/markdown-content', () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <span data-testid="markdown-stub">{content}</span>
  ),
}));

// The full Cortex page touches scoped config + symbionts + agent runs.
// Stub each hook so the nav-only tests don't need the whole daemon stack.
mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: {
      context: {
        cortex_enabled: true,
        digest_tier: 5000,
        prompt_search: true,
        prompt_max_spores: 3,
        session_start_digest_enabled: false,
      },
      canopy: {
        exclude: { patterns: [] },
        refresh: { background_enabled: true, background_period_minutes: 60 },
      },
      cortex: {
        canopy: { injection: { enabled: true, size_threshold: 800 } },
      },
    },
    local: {},
    isLoading: false,
    setField: vi.fn(),
    resetField: vi.fn(),
    promoteField: vi.fn(),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-symbionts', () => ({
  useSymbionts: () => ({ data: { symbionts: [] } }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentRuns: () => ({ data: { runs: [] }, isFetching: false, refetch: vi.fn() }),
}));

mock.module('../../packages/myco/ui/src/components/mycelium/DigestView', () => ({
  DigestView: () => <div data-testid="digest-view-stub" />,
}));

const { default: Cortex } = await import('../../packages/myco/ui/src/pages/Cortex');

/* ---------- Helpers ---------- */

function renderAt(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The map panel hits /canopy/map by default — return an empty map so
  // panels render without spinners holding the assertions back.
  fetchJsonMock.mockImplementation(async (url: string) => {
    if (url === '/canopy/map') return { is_empty: true, content: '', message: 'No Canopy Map yet.' };
    if (url.startsWith('/canopy/entries')) return { rows: [], total: 0, limit: 50, offset: 0 };
    if (url === '/cortex/instructions') return { content: '', generatedAt: null, sourceRunId: null, enabled: true, stored: false };
    return null;
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Cortex />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Cortex unified Canopy tab', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('renders the Canopy Overview section by default when ?tab=canopy', async () => {
    renderAt('/cortex?tab=canopy');
    // Overview shows the Collection section header from the old CanopyTab.
    await waitFor(() => {
      expect(screen.getByText('Collection')).toBeInTheDocument();
    });
    // Secondary nav shows Overview / Entries / Map.
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Entries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
  });

  it('switching the secondary nav to Entries shows the entries list', async () => {
    renderAt('/cortex?tab=canopy');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Entries' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Entries' }));
    // The entries panel renders the empty-state message when total=0.
    await waitFor(() => {
      expect(screen.getByTestId('canopy-entries-empty')).toBeInTheDocument();
    });
  });

  it('switching the secondary nav to Map shows the map panel', async () => {
    renderAt('/cortex?tab=canopy');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    await waitFor(() => {
      expect(screen.getByTestId('project-map-panel')).toBeInTheDocument();
    });
  });

  it('legacy ?tab=canopy-entries deep-link lands on the entries section', async () => {
    renderAt('/cortex?tab=canopy-entries');
    await waitFor(() => {
      expect(screen.getByTestId('canopy-entries-empty')).toBeInTheDocument();
    });
  });

  it('legacy ?tab=project-map deep-link lands on the map section', async () => {
    renderAt('/cortex?tab=project-map');
    await waitFor(() => {
      expect(screen.getByTestId('project-map-panel')).toBeInTheDocument();
    });
  });

  it('?tab=canopy&section=entries lands on the entries section', async () => {
    renderAt('/cortex?tab=canopy&section=entries');
    await waitFor(() => {
      expect(screen.getByTestId('canopy-entries-empty')).toBeInTheDocument();
    });
  });

  it('?tab=canopy&section=map lands on the map section', async () => {
    renderAt('/cortex?tab=canopy&section=map');
    await waitFor(() => {
      expect(screen.getByTestId('project-map-panel')).toBeInTheDocument();
    });
  });
});
