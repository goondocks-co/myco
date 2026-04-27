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

// Stub the markdown renderer to keep the test environment simple — the panel
// just hands content to MarkdownContent, so a span is enough to assert on.
mock.module('../../packages/myco/ui/src/components/ui/markdown-content', () => ({
  MarkdownContent: ({ content }: { content: string }) => (
    <span data-testid="markdown-stub">{content}</span>
  ),
}));

const { ProjectMapPanel } = await import(
  '../../packages/myco/ui/src/components/canopy/ProjectMapPanel'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPanel() {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ProjectMapPanel />
    </QueryClientProvider>,
  );
}

const POPULATED_MAP: CanopyMapResponse = {
  content: '# Project Map\n\nA narrative tour of the codebase.',
  generated_at: 1_700_000_000,
  token_estimate: 4321,
  inputs_hash: 'abc123',
};

const EMPTY_MAP: CanopyMapResponse = {
  content: '',
  is_empty: true,
  message: 'No project map yet.',
};

/* ---------- Tests ---------- */

describe('ProjectMapPanel', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('renders the empty state with an emphasized regenerate button when no map exists', async () => {
    fetchJsonMock.mockResolvedValue(EMPTY_MAP);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-empty')).toBeInTheDocument();
    });

    expect(screen.getByText('No project map yet.')).toBeInTheDocument();
    // The empty branch renders its own emphasized regenerate button.
    expect(screen.getByTestId('project-map-regenerate-empty')).toBeInTheDocument();
    // Header shows the no-map badge and em-dash placeholders for metadata.
    expect(screen.getByText('No map yet')).toBeInTheDocument();
  });

  it('renders the rendered map content when a row exists', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-content')).toBeInTheDocument();
    });

    // Markdown is handed to the (stubbed) renderer verbatim.
    expect(screen.getByTestId('markdown-stub')).toHaveTextContent('A narrative tour of the codebase.');
    // Token estimate surfaces in the header strip.
    expect(screen.getByTestId('project-map-tokens')).toHaveTextContent('4,321');
  });

  it('regenerate click POSTs with force_cold_start: false by default', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-1' });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-regenerate')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('project-map-regenerate'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });

    const call = postJsonMock.mock.calls[0];
    expect(String(call[0])).toBe('/canopy/map/regenerate');
    expect(call[1]).toEqual({ force_cold_start: false });
  });

  it('toggling Force cold start propagates to the POST body', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-2' });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-regenerate')).toBeInTheDocument();
    });

    // Flip the switch (a button with role="switch") on.
    const toggle = screen.getByRole('switch');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('project-map-regenerate'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });

    expect(postJsonMock.mock.calls[0][1]).toEqual({ force_cold_start: true });
  });

  it('shows "Generating…" and disables the button while the regenerate POST is in flight', async () => {
    fetchJsonMock.mockResolvedValue(POPULATED_MAP);

    // A pending promise that never resolves during the assertion window —
    // mutation stays in `isPending`.
    let resolveLater!: (value: unknown) => void;
    postJsonMock.mockReturnValue(
      new Promise((resolve) => {
        resolveLater = resolve;
      }),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('project-map-regenerate')).toBeInTheDocument();
    });

    const button = screen.getByTestId('project-map-regenerate') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });
    expect(button.textContent ?? '').toContain('Generating');

    // Cleanly resolve so React Query doesn't warn about an unresolved promise.
    resolveLater({ ok: true, run_id: 'run-3' });
  });
});
