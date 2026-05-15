// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const statusFixture = {
  connection_scope: 'grove' as const,
  grove: { id: 'g1', name: 'Foo', slug: 'foo', mode: 'team' },
  project: { id: 'p', name: 'p', root: '/' },
  enabled: true,
  worker_url: 'https://x.workers.dev',
  has_team_key: true,
  team_key: 'tk1',
  has_api_key: false,
  api_key: null,
  healthy: true,
  pending_sync_count: 0,
  local_team_package_version: null,
  local_team_package_source: null,
  cached_team_package_version: null,
  deployed_worker_version: null,
  worker_update_available: false,
  collective_connected: false,
  collective_url: null,
  collective_project_id: null,
  collective_last_settings_sync: null,
  collective_last_heartbeat: null,
  collective_capabilities: [],
  collective_settings: {},
  vector_reindex_status: null,
  vector_reindex_last_table: null,
  vector_reindex_last_error: null,
  vector_reindex_last_run_at: null,
  vector_reindex_last_processed: null,
  vector_reindex_last_reindexed: null,
  vector_reindex_last_deleted: null,
  machine_id: 'm',
  package_version: '0',
  schema_version: 9,
  sync_protocol_version: 1,
  mcp_token: null,
  mcp_endpoint: null,
  mcp_healthy: false,
};

mock.module('../../packages/myco/ui/src/hooks/use-team', () => ({
  useTeamStatus: () => ({
    data: statusFixture,
    isLoading: false,
  }),
  useTeamQueueStats: () => ({ data: undefined, isLoading: false }),
  useTeamSyncSummary: () => ({ data: undefined, isLoading: false }),
  useTeamDlq: () => ({ data: undefined, isLoading: false }),
  isTokenMissing: () => false,
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: undefined }),
}));

// Import after mocks so the page sees the mocked modules.
import { TeamPage } from '../../packages/myco/ui/src/pages/Team';

function wrap(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <TeamPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// Mirrors App.tsx's `TeamMaintenanceRedirect`. Kept inline so this test
// asserts the redirect contract end-to-end without mounting the full App
// (which would require mocking every layout dependency). If the real
// redirect changes, this test must change too — by design.
function TeamMaintenanceRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/team?tab=sync`} replace />;
}

function wrapWithRoutes(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/g/:groveSlug/team" element={<TeamPage />} />
          <Route path="/g/:groveSlug/team/maintenance" element={<TeamMaintenanceRedirect />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe('TeamPage tabs', () => {
  it('renders Status tab by default', async () => {
    render(wrap('/g/foo/team'));
    await waitFor(() => expect(screen.getByText(/Grove Credentials/i)).toBeInTheDocument());
  });
  it('renders Sync tab when ?tab=sync', async () => {
    render(wrap('/g/foo/team?tab=sync'));
    await waitFor(() => expect(screen.getByText(/Worker/i)).toBeInTheDocument());
  });
  it('renders Members placeholder when ?tab=members', async () => {
    render(wrap('/g/foo/team?tab=members'));
    await waitFor(() => expect(screen.getByText(/Members tab coming up/i)).toBeInTheDocument());
  });
  it('redirects /team/maintenance → /team?tab=sync', async () => {
    render(wrapWithRoutes('/g/foo/team/maintenance'));
    // After the redirect resolves, the Sync tab body is mounted —
    // assert on its "Worker" section header.
    await waitFor(() => expect(screen.getByText(/Worker/i)).toBeInTheDocument());
  });
});
