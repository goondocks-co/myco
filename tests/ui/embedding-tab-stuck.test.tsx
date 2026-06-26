// @vitest-environment jsdom

/**
 * EmbeddingTab — canopy describe `stuck` count display + "Retry stuck" action.
 *
 * Pins the contract added in B4:
 *   - when `canopy_describe.stuck > 0` the stat card sublabel shows "⚠ stuck: N"
 *     and a "Retry stuck" button appears in the Actions section
 *   - clicking the button POSTs to /canopy/describe/retry-stuck
 *   - when `stuck === 0` the sublabel shows the normal pending/fresh label and
 *     no "Retry stuck" button is rendered
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import type { EmbeddingDetails } from '../../packages/myco/ui/src/hooks/use-embedding-details';

/* ---------- API mock ---------- */

let postJsonImpl: (path: string, body?: unknown) => Promise<unknown> = async () => ({});
const postJsonSpy = vi.fn((path: string, body?: unknown) => postJsonImpl(path, body));

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: async () => ({}),
  postJson: (path: string, body?: unknown) => postJsonSpy(path, body),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

/* ---------- Hook mock ---------- */

type UseEmbeddingDetailsResult = {
  data: EmbeddingDetails | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
};

let embeddingDetailsResult: UseEmbeddingDetailsResult = {
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
};

mock.module('../../packages/myco/ui/src/hooks/use-embedding-details', () => ({
  useEmbeddingDetails: () => embeddingDetailsResult,
}));

/* ---------- ActionConfirmDialog mock (avoids Portal/dialog deps) ---------- */

mock.module('../../packages/myco/ui/src/components/operations/ActionConfirmDialog', () => ({
  ActionConfirmDialog: () => null,
  actionRequiresConfirmation: () => false,
}));

/* ---------- Import component (must come AFTER mocks) ---------- */

const { EmbeddingTab } = await import(
  '../../packages/myco/ui/src/components/operations/EmbeddingTab'
);

/* ---------- Fixtures ---------- */

const BASE_EMBEDDING: EmbeddingDetails = {
  total: 100,
  by_namespace: {},
  models: {},
  pending: {
    sessions: 0,
    spores: 0,
    plans: 0,
    artifacts: 0,
    skill_records: 0,
    canopy_entries: 0,
  },
  namespace_breakdown: {
    sessions:      { embedded: 10, pending: 0, stale: 0, total: 10 },
    spores:        { embedded: 5,  pending: 0, stale: 0, total: 5  },
    plans:         { embedded: 3,  pending: 0, stale: 0, total: 3  },
    artifacts:     { embedded: 0,  pending: 0, stale: 0, total: 0  },
    skill_records: { embedded: 2,  pending: 0, stale: 0, total: 2  },
    canopy_entries:{ embedded: 80, pending: 0, stale: 0, total: 80 },
  },
  provider: { name: 'openai', model: 'text-embedding-3-small', available: true },
  canopy_describe: { pending: 0, undescribed: 0, stale: 0, stuck: 0 },
};

const WITH_STUCK: EmbeddingDetails = {
  ...BASE_EMBEDDING,
  canopy_describe: { pending: 0, undescribed: 0, stale: 0, stuck: 3 },
};

const WITH_STUCK_AND_PENDING: EmbeddingDetails = {
  ...BASE_EMBEDDING,
  canopy_describe: { pending: 5, undescribed: 2, stale: 3, stuck: 3 },
};

/* ---------- Helpers ---------- */

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <EmbeddingTab />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* ---------- Tests ---------- */

beforeEach(() => {
  postJsonImpl = async () => ({ reset: 3 });
  postJsonSpy.mockClear();
});

afterEach(() => {
  embeddingDetailsResult = {
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  };
});

describe('EmbeddingTab — canopy describe stuck count', () => {
  it('shows ⚠ stuck: N in the Canopy Scribe card sublabel when stuck > 0', () => {
    embeddingDetailsResult = { data: WITH_STUCK, isLoading: false, isError: false, error: null };

    renderTab();

    expect(screen.getByText(/⚠ stuck: 3/)).toBeTruthy();
  });

  it('shows ⚠ stuck: N combined with pending info when both are > 0', () => {
    embeddingDetailsResult = { data: WITH_STUCK_AND_PENDING, isLoading: false, isError: false, error: null };

    renderTab();

    // Sublabel: "⚠ stuck: 3 · 2 new, 3 stale"
    expect(screen.getByText(/⚠ stuck: 3/)).toBeTruthy();
    expect(screen.getByText(/2 new, 3 stale/)).toBeTruthy();
  });

  it('shows fresh sublabel when stuck === 0 and pending === 0', () => {
    embeddingDetailsResult = { data: BASE_EMBEDDING, isLoading: false, isError: false, error: null };

    renderTab();

    expect(screen.getByText('fresh')).toBeTruthy();
    expect(screen.queryByText(/⚠ stuck/)).toBeNull();
  });
});

describe('EmbeddingTab — Retry stuck button', () => {
  it('renders the Retry stuck button when stuck > 0', () => {
    embeddingDetailsResult = { data: WITH_STUCK, isLoading: false, isError: false, error: null };

    renderTab();

    expect(screen.getByRole('button', { name: /retry stuck/i })).toBeTruthy();
  });

  it('does NOT render the Retry stuck button when stuck === 0', () => {
    embeddingDetailsResult = { data: BASE_EMBEDDING, isLoading: false, isError: false, error: null };

    renderTab();

    expect(screen.queryByRole('button', { name: /retry stuck/i })).toBeNull();
  });

  it('POSTs to /canopy/describe/retry-stuck when the button is clicked', async () => {
    embeddingDetailsResult = { data: WITH_STUCK, isLoading: false, isError: false, error: null };

    renderTab();

    const btn = screen.getByRole('button', { name: /retry stuck/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(postJsonSpy.mock.calls.length).toBeGreaterThan(0);
    });

    const [calledPath] = postJsonSpy.mock.calls[0] as [string, unknown];
    expect(calledPath).toBe('/canopy/describe/retry-stuck');
  });

  it('shows a success message after clicking Retry stuck', async () => {
    postJsonImpl = async () => ({ reset: 3 });
    embeddingDetailsResult = { data: WITH_STUCK, isLoading: false, isError: false, error: null };

    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /retry stuck/i }));

    await waitFor(() => {
      expect(screen.getByText(/reset 3 stuck row/i)).toBeTruthy();
    });
  });
});
