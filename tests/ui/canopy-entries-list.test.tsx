// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
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
  patchJson: vi.fn(),
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
const { CanopyEntriesPanel } = await import(
  '../../packages/myco/ui/src/components/canopy/CanopyEntriesPanel'
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
    <PowerProvider>
      <QueryClientProvider client={client}>
        <CanopyEntriesList
          selectedPath={props.selectedPath}
          onSelectPath={props.onSelectPath ?? (() => {})}
        />
      </QueryClientProvider>
    </PowerProvider>,
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

  it('renders visible Language and Described labels next to the dropdowns', async () => {
    fetchJsonMock.mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0 });
    renderList({});
    await waitFor(() => {
      expect(screen.getByTestId('canopy-entries-empty')).toBeInTheDocument();
    });
    // The toolbar renders Language and Described as visible inline labels —
    // not just as the placeholder text inside the dropdown. Embedded is no
    // longer a top-level filter (no user action it gates), so it's not in
    // the toolbar — the per-row Embedded column still shows status.
    expect(screen.getByText('Described')).toBeInTheDocument();
    expect(screen.getByText('Language')).toBeInTheDocument();
  });

  it('typing in the search box (after debounce) issues a request with q=', async () => {
    fetchJsonMock.mockResolvedValue({ rows: [], total: 0, limit: 50, offset: 0 });
    renderList({});
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());

    const input = screen.getByLabelText('Search files') as HTMLInputElement;
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.change(input, { target: { value: 'auth' } });

    await waitFor(() => {
      const lastUrl = String(fetchJsonMock.mock.calls.at(-1)?.[0] ?? '');
      expect(lastUrl).toContain('q=auth');
    }, { timeout: 1500 });
  });

  it('clicking a sortable column header changes the sort_by query param', async () => {
    fetchJsonMock.mockResolvedValue({
      rows: [makeEntry({ path: 'src/foo.ts' })],
      total: 1,
      limit: 50,
      offset: 0,
    });
    renderList({});
    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());

    const { fireEvent } = await import('@testing-library/react');
    // Click the Language header.
    const languageBtn = screen.getByLabelText('Sort by Language');
    fireEvent.click(languageBtn);

    await waitFor(() => {
      const lastUrl = String(fetchJsonMock.mock.calls.at(-1)?.[0] ?? '');
      expect(lastUrl).toContain('sort_by=language');
      expect(lastUrl).toContain('sort_dir=asc');
    });

    // Click again — should toggle to desc.
    fireEvent.click(languageBtn);
    await waitFor(() => {
      const lastUrl = String(fetchJsonMock.mock.calls.at(-1)?.[0] ?? '');
      expect(lastUrl).toContain('sort_by=language');
      expect(lastUrl).toContain('sort_dir=desc');
    });
  });
});

/* ---------- Panel slide-out tests ---------- */

function renderPanel() {
  const client = makeQueryClient();
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CanopyEntriesPanel />
        </MemoryRouter>
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('CanopyEntriesPanel slide-out', () => {
  beforeEach(() => {
    fetchJsonMock.mockReset();
    postJsonMock.mockReset();
  });

  it('does not render the detail panel before any row is selected', async () => {
    fetchJsonMock.mockResolvedValue({
      rows: [makeEntry({ path: 'src/foo.ts' })],
      total: 1,
      limit: 50,
      offset: 0,
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('canopy-entry-detail-panel')).toBeNull();
  });

  it('opens the slide-out detail when a row is clicked, keeping the list visible', async () => {
    // The list query and the entry-fetch query share the fetchJson mock.
    // Return list rows on the first call, then the entry on subsequent calls.
    fetchJsonMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/canopy/entries/')) {
        return Promise.resolve(makeEntry({ path: 'src/foo.ts' }));
      }
      return Promise.resolve({
        rows: [makeEntry({ path: 'src/foo.ts' })],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    });

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('canopy-entry-row-src/foo.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-detail-panel')).toBeInTheDocument();
    });

    // List remains visible while the slide-out is open.
    expect(screen.getByTestId('canopy-entry-row-src/foo.ts')).toBeInTheDocument();
  });

  it('closes the slide-out when the X button is clicked', async () => {
    fetchJsonMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/canopy/entries/')) {
        return Promise.resolve(makeEntry({ path: 'src/foo.ts' }));
      }
      return Promise.resolve({
        rows: [makeEntry({ path: 'src/foo.ts' })],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
    });

    const { fireEvent } = await import('@testing-library/react');
    fireEvent.click(screen.getByTestId('canopy-entry-row-src/foo.ts'));

    await waitFor(() => {
      expect(screen.getByTestId('canopy-entry-detail-panel')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('canopy-entry-detail-close'));

    await waitFor(() => {
      expect(screen.queryByTestId('canopy-entry-detail-panel')).toBeNull();
    });
  });
});
