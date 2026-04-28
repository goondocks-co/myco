// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CanopyEntryRow } from '../../packages/myco/ui/src/hooks/use-canopy';

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

const { CanopyEntryDetail } = await import(
  '../../packages/myco/ui/src/components/canopy/CanopyEntryDetail'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderDetail(path: string) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopyEntryDetail path={path} />
    </QueryClientProvider>,
  );
}

function makeEntry(overrides: Partial<CanopyEntryRow> = {}): CanopyEntryRow {
  return {
    project_id: 'proj-1',
    machine_id: 'local',
    path: 'src/foo.ts',
    content_hash: 'a'.repeat(64),
    size_bytes: 1234,
    token_estimate: 250,
    line_count: 42,
    language: 'typescript',
    exports_json: '["foo","bar"]',
    imports_json: '["react","./util"]',
    top_comment: '// Top of file comment.',
    mechanical_updated_at: 1_700_000_000,
    llm_description: 'Foo utilities for the bar service.',
    llm_updated_at: 1_700_500_000,
    embedded: 1,
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('CanopyEntryDetail', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('renders metadata, description, and parsed exports/imports for a populated entry', async () => {
    fetchJsonMock.mockResolvedValue(makeEntry());

    renderDetail('src/foo.ts');

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-detail')).toBeInTheDocument();
    });

    expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByText('Embedded')).toBeInTheDocument();
    expect(screen.getByText('Foo utilities for the bar service.')).toBeInTheDocument();
    // Exports parsed from JSON
    expect(screen.getByText('foo')).toBeInTheDocument();
    expect(screen.getByText('bar')).toBeInTheDocument();
    // Imports parsed from JSON
    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('./util')).toBeInTheDocument();
    // Top comment surfaces
    expect(screen.getByText('// Top of file comment.')).toBeInTheDocument();
  });

  it('renders the empty-description state for an entry with no llm_description', async () => {
    fetchJsonMock.mockResolvedValue(
      makeEntry({ llm_description: null, llm_updated_at: null, embedded: 0 }),
    );

    renderDetail('src/foo.ts');

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-detail')).toBeInTheDocument();
    });
    expect(
      screen.getByText("The Myco agent hasn't described this file yet."),
    ).toBeInTheDocument();
    expect(screen.getByText('Not embedded')).toBeInTheDocument();
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  it('fires the re-embed POST and shows queued feedback on success', async () => {
    fetchJsonMock.mockResolvedValue(makeEntry({ embedded: 1 }));
    postJsonMock.mockResolvedValue({ ok: true });

    renderDetail('src/foo.ts');

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-reembed')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-entry-reembed'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });

    const call = postJsonMock.mock.calls[0];
    // Path is URL-encoded; includes the /reembed suffix.
    expect(String(call[0])).toBe('/canopy/entries/src%2Ffoo.ts/reembed');

    await waitFor(() => {
      expect(screen.getByText('Queued for re-embed')).toBeInTheDocument();
    });
  });

  it('fires the re-describe POST and shows queued feedback on success', async () => {
    fetchJsonMock.mockResolvedValue(makeEntry({ embedded: 1 }));
    postJsonMock.mockResolvedValue({ ok: true, run_id: 'run-123' });

    renderDetail('src/foo.ts');

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-redescribe')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-entry-redescribe'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledTimes(1);
    });

    const call = postJsonMock.mock.calls[0];
    // Path is URL-encoded; includes the /redescribe suffix.
    expect(String(call[0])).toBe('/canopy/entries/src%2Ffoo.ts/redescribe');

    await waitFor(() => {
      expect(screen.getByText('Queued for re-describe')).toBeInTheDocument();
    });
  });

  it('disables the re-describe button while the request is in flight', async () => {
    fetchJsonMock.mockResolvedValue(makeEntry({ embedded: 1 }));
    // Hold the postJson promise open so the button stays in the pending state.
    let resolveDescribe: (value: { ok: true }) => void = () => {};
    postJsonMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveDescribe = resolve;
      }),
    );

    renderDetail('src/foo.ts');

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-redescribe')).toBeInTheDocument();
    });

    const button = screen.getByTestId('canopy-entry-redescribe') as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });
    expect(button.textContent).toContain('Describing');

    // Release the held promise so React Query can settle and prevent the test
    // suite leaking pending state into the next case.
    resolveDescribe({ ok: true });
  });
});
