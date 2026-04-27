// @vitest-environment jsdom

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import type { EmbeddingDetails } from '../../packages/myco/ui/src/hooks/use-embedding-details';

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

// Stub useEmbeddingDetails directly — bypasses the PowerProvider requirement
// that usePowerQuery imposes. The fixture is set per-test via FIXTURE_REF.
const FIXTURE_REF: { current: EmbeddingDetails | null } = { current: null };

mock.module('../../packages/myco/ui/src/hooks/use-embedding-details', () => ({
  useEmbeddingDetails: () => ({
    data: FIXTURE_REF.current,
    isLoading: false,
    isError: false,
    error: null,
  }),
}));

// Stub the database details and log feed hooks — Operations imports them
// eagerly but the embedding tab doesn't render their UI.
mock.module('../../packages/myco/ui/src/hooks/use-database-details', () => ({
  useDatabaseDetails: () => ({ data: null, isLoading: false, isError: false, error: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-log-feed', () => ({
  useLogFeed: () => ({
    filteredEntries: [],
    scrollRef: { current: null },
    autoScroll: true,
    setAutoScroll: () => {},
    hasNewEntries: false,
    handleScroll: () => {},
    scrollToBottom: () => {},
  }),
}));

// Settings/scoped-config hook is consumed only by tabs we don't exercise.
mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({ effective: null }),
}));

// Imported AFTER the mocks so the module-level imports resolve to the stubs.
const { default: Operations } = await import(
  '../../packages/myco/ui/src/pages/Operations'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const FIXTURE: EmbeddingDetails = {
  total: 250,
  by_namespace: {
    sessions: { embedded: 100, stale: 0 },
    spores: { embedded: 40, stale: 0 },
    plans: { embedded: 10, stale: 0 },
    artifacts: { embedded: 20, stale: 0 },
    skill_records: { embedded: 5, stale: 0 },
    canopy_entries: { embedded: 75, stale: 3 },
  },
  models: { 'test-model': 250 },
  pending: {
    sessions: 0,
    spores: 0,
    plans: 0,
    artifacts: 0,
    skill_records: 0,
    canopy_entries: 7,
  },
  provider: { name: 'test', model: 'test-model', available: true },
};

function renderPage() {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <Operations />
    </QueryClientProvider>,
  );
}

/* ---------- Tests ---------- */

describe('Operations — canopy_entries namespace', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
    fetchJsonMock.mockResolvedValue(FIXTURE);
    FIXTURE_REF.current = FIXTURE;
  });

  it('renders the canopy_entries row in the namespace breakdown table as "Files"', async () => {
    renderPage();

    // The namespace table is rendered inside a region labelled "Embedding namespace breakdown".
    const table = await screen.findByLabelText('Embedding namespace breakdown');
    expect(table).toBeInTheDocument();

    // Display label is "Files" per universal-search facet (Task 10).
    const rowText = table.textContent ?? '';
    expect(rowText).toContain('Files');

    // Numeric counts for the canopy row are surfaced.
    expect(rowText).toContain('75'); // embedded
    expect(rowText).toContain('7'); // pending
    expect(rowText).toContain('3'); // stale
  });

  it('does not surface the raw "canopy_entries" identifier in the table', async () => {
    renderPage();

    const table = await screen.findByLabelText('Embedding namespace breakdown');
    // Internal identifier should not leak into the user-facing label column.
    expect(table.textContent ?? '').not.toContain('canopy_entries');
  });

  it('routes the "Rebuild all" action through the aggregate endpoint that covers canopy_entries server-side', async () => {
    postJsonMock.mockResolvedValue({
      queued: 250,
      embedded: 250,
      stale_reembedded: 3,
      passes: 1,
      batch_size: 64,
      remaining_queue_depth: 0,
    });
    // Auto-confirm the destructive action. jsdom's window.confirm returns
    // false by default; the handler bails before calling postJson otherwise.
    const g = globalThis as unknown as { confirm?: (msg?: string) => boolean };
    const origConfirm = g.confirm;
    g.confirm = () => true;
    try {
      renderPage();

      const rebuildBtn = await screen.findByRole('button', { name: /rebuild all/i });
      fireEvent.click(rebuildBtn);

      await waitFor(() => {
        const urls = postJsonMock.mock.calls.map((c) => c[0] as string);
        expect(urls).toContain('/embedding/rebuild');
      });
    } finally {
      g.confirm = origConfirm;
    }
  });

  it('routes "Clean orphans" through the aggregate endpoint (server iterates all namespaces including canopy_entries)', async () => {
    postJsonMock.mockResolvedValue({ orphans_cleaned: 0 });
    renderPage();

    const cleanBtn = await screen.findByRole('button', { name: /clean orphans/i });
    fireEvent.click(cleanBtn);

    await waitFor(() => {
      const urls = postJsonMock.mock.calls.map((c) => c[0] as string);
      expect(urls).toContain('/embedding/clean-orphans');
    });
  });
});
