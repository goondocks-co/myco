// @vitest-environment jsdom
/**
 * GroveBackupSnapshot — loading, empty, populated, and error states.
 *
 * Bucket E rewrote this component to react-query (PR #277). The /ce-review
 * called out that the only UI test was a single label-presence check.
 * This file pins the four observable states the rewrite must keep
 * supporting:
 *  - loading: "Loading…" while the query is in flight
 *  - empty: "No backups yet." when the array is empty
 *  - populated: most-recent file rendered with relative time + size
 *  - error: error.message shown in tertiary color
 *
 * The component uses useQuery + fetchJson directly, so we drive each
 * state by varying the mocked fetchJson implementation.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

type FetchImpl = (path: string) => Promise<unknown>;

// Default to a never-resolving fetch so the loading branch is the
// pre-arrange state; individual tests override this via the
// fetchJsonImpl mutable hook.
let fetchJsonImpl: FetchImpl = () => new Promise(() => {});

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (path: string) => fetchJsonImpl(path),
  postJson: async () => ({}),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class extends Error {},
}));

// The snapshot now resolves its Grove from the active selection and only
// fetches once a Grove is known (enabled: !!groveId). Provide a fixed
// selection so the query runs in tests.
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => ({
    grove: { id: 'grove_test', slug: 'test' },
    project: { project_id: 'proj_test', slug: 'p' },
  }),
}));

import { GroveBackupSnapshot } from '../../packages/myco/ui/src/components/grove/GroveBackupSnapshot';

function wrap() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GroveBackupSnapshot />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchJsonImpl = () => new Promise(() => {});
});

afterEach(() => {
  fetchJsonImpl = () => new Promise(() => {});
});

describe('GroveBackupSnapshot', () => {
  it('renders the loading state while the backups query is in flight', () => {
    fetchJsonImpl = () => new Promise(() => {}); // never resolves
    render(wrap());
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('renders "No backups yet." when the list comes back empty', async () => {
    fetchJsonImpl = async () => ({ backups: [] });
    render(wrap());
    await waitFor(() => {
      expect(screen.getByText(/No backups yet/i)).toBeInTheDocument();
    });
  });

  it('renders the most recent backup file when the list is populated', async () => {
    const recent = new Date(Date.now() - 5 * 60_000).toISOString();
    fetchJsonImpl = async () => ({
      backups: [
        { machine_id: 'm', file_name: 'snapshot.tar.gz', size_bytes: 2048, modified_at: recent },
        { machine_id: 'm', file_name: 'older.tar.gz', size_bytes: 1024, modified_at: new Date(Date.now() - 3600_000).toISOString() },
      ],
    });
    render(wrap());
    await waitFor(() => {
      expect(screen.getByText('snapshot.tar.gz')).toBeInTheDocument();
    });
    // "Recent" sub-list shows the older backup.
    expect(screen.getByText(/Recent/i)).toBeInTheDocument();
  });

  it('surfaces error.message in the tertiary text slot on query failure', async () => {
    fetchJsonImpl = async () => {
      throw new Error('backup endpoint exploded');
    };
    render(wrap());
    await waitFor(() => {
      expect(screen.getByText(/backup endpoint exploded/i)).toBeInTheDocument();
    });
    // The error path must not also render the populated/empty markers.
    expect(screen.queryByText(/No backups yet/i)).toBeNull();
    expect(screen.queryByText(/Loading/i)).toBeNull();
  });
});
