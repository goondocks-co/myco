// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  CanopyEntriesListResponse,
  CanopyEntryRow,
} from '../../packages/myco/ui/src/hooks/use-canopy';

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

// Imported AFTER the mock so the module-level fetchJson resolves to the stub.
const { CanopyEntriesList } = await import(
  '../../packages/myco/ui/src/components/canopy/CanopyEntriesList'
);

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderList(props: {
  selectedPath?: string | undefined;
  onSelectPath?: (path: string) => void;
}) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopyEntriesList
        selectedPath={props.selectedPath}
        onSelectPath={props.onSelectPath ?? (() => {})}
      />
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
    imports_json: '["react"]',
    top_comment: null,
    mechanical_updated_at: 1_700_000_000,
    llm_description: null,
    llm_updated_at: null,
    embedded: 0,
    ...overrides,
  };
}

/* ---------- Tests ---------- */

describe('CanopyEntriesList', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('renders rows with the expected columns', async () => {
    const response: CanopyEntriesListResponse = {
      rows: [
        makeEntry({ path: 'src/foo.ts', language: 'typescript', token_estimate: 250 }),
        makeEntry({
          path: 'src/bar.ts',
          language: 'typescript',
          embedded: 1,
          llm_description: 'Bar utilities.',
          llm_updated_at: 1_700_500_000,
          token_estimate: 410,
        }),
      ],
      total: 2,
      limit: 50,
      offset: 0,
    };
    fetchJsonMock.mockResolvedValue(response);

    renderList({});

    await waitFor(() => {
      expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    });
    expect(screen.getByText('src/bar.ts')).toBeInTheDocument();
    // Token counts render with locale separators.
    expect(screen.getByText('250')).toBeInTheDocument();
    expect(screen.getByText('410')).toBeInTheDocument();
    // Two rows rendered.
    expect(screen.getAllByRole('row').length).toBeGreaterThanOrEqual(3); // header + 2 rows
  });

  it('renders the empty state when the API returns zero rows', async () => {
    fetchJsonMock.mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0 });
    renderList({});
    await waitFor(() => {
      expect(screen.getByTestId('canopy-entries-empty')).toBeInTheDocument();
    });
  });

  it('highlights the selected row', async () => {
    fetchJsonMock.mockResolvedValue({
      rows: [makeEntry({ path: 'src/foo.ts' })],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderList({ selectedPath: 'src/foo.ts' });
    await waitFor(() => {
      const row = screen.getByTestId('canopy-entry-row-src/foo.ts');
      expect(row.getAttribute('aria-selected')).toBe('true');
    });
  });
});
