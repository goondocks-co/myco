// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CanopyMapResponse } from '../../packages/myco/ui/src/hooks/use-canopy';

/* ---------- API mock ---------- */

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

const { CanopyMapPanel } = await import(
  '../../packages/myco/ui/src/components/canopy/CanopyMapPanel'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPanel() {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopyMapPanel />
    </QueryClientProvider>,
  );
}

const POPULATED_MAP: CanopyMapResponse = {
  content: '# Canopy Map\n\nA tour of the codebase.',
  generated_at: 1_700_000_000,
  token_estimate: 4321,
  inputs_hash: 'abc123',
};

const EMPTY_MAP: CanopyMapResponse = {
  content: '',
  is_empty: true,
  message: 'No Canopy Map yet.',
};

/* ---------- Tests ---------- */

describe('CanopyMapPanel', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('renders the empty state with a single Generate Map button when no map exists', async () => {
    fetchJsonMock.mockResolvedValue(EMPTY_MAP);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-empty')).toBeInTheDocument();
    });

    expect(screen.getByText('No Canopy Map yet.')).toBeInTheDocument();
    expect(screen.getByTestId('canopy-map-generate')).toBeInTheDocument();
    expect(screen.getByText('No map yet')).toBeInTheDocument();
    // Refresh + Rebuild are NOT in the empty state — those only appear when
    // a map already exists.
    expect(screen.queryByTestId('canopy-map-refresh')).toBeNull();
    expect(screen.queryByTestId('canopy-map-rebuild')).toBeNull();
  });

  it('renders the map content when a row exists', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-content')).toBeInTheDocument();
    });

    expect(screen.getByTestId('markdown-stub')).toHaveTextContent('A tour of the codebase.');
    expect(screen.getByTestId('project-map-tokens')).toHaveTextContent('4,321');
  });

  it('Refresh button POSTs with force_cold_start: false', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-r' });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canopy-map-refresh')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-map-refresh'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });
    const call = postJsonMock.mock.calls[0];
    expect(String(call[0])).toBe('/canopy/map/regenerate');
    expect(call[1]).toEqual({ force_cold_start: false });
  });

  it('Rebuild button POSTs with force_cold_start: true', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-rb' });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canopy-map-rebuild')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-map-rebuild'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });
    expect(postJsonMock.mock.calls[0][1]).toEqual({ force_cold_start: true });
  });

  it('disables both Refresh and Rebuild while a request is in flight', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);

    let resolveLater!: (value: unknown) => void;
    postJsonMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLater = resolve;
      }),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canopy-map-refresh')).toBeInTheDocument();
    });

    const refreshBtn = screen.getByTestId('canopy-map-refresh') as HTMLButtonElement;
    const rebuildBtn = screen.getByTestId('canopy-map-rebuild') as HTMLButtonElement;
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(refreshBtn.disabled).toBe(true);
    });
    expect(rebuildBtn.disabled).toBe(true);
    expect(refreshBtn.textContent ?? '').toContain('Refreshing');

    resolveLater({ ok: true, run_id: 'run-final' });
  });

  it('Generate Map button (empty state) POSTs with force_cold_start: true', async () => {
    fetchJsonMock.mockResolvedValue(EMPTY_MAP);
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-empty' });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('canopy-map-generate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-map-generate'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });
    expect(postJsonMock.mock.calls[0][1]).toEqual({ force_cold_start: true });
  });
});
