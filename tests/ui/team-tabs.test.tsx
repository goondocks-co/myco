// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  version_status: 'ok' as const,
  daemon_protocol_version: 2,
  worker_protocol_version: 2,
  worker_min_client_version: 1,
};

let lastStatusTeamId: string | undefined;

mock.module('../../packages/myco/ui/src/hooks/use-team', () => ({
  useTeamStatus: (teamId?: string) => {
    lastStatusTeamId = teamId;
    return { data: statusFixture, isLoading: false };
  },
  useTeamQueueStats: () => ({ data: undefined, isLoading: false }),
  useTeamSyncSummary: () => ({ data: undefined, isLoading: false }),
  useTeamDlq: () => ({ data: undefined, isLoading: false }),
  useTeamRegistry: () => ({
    data: {
      teams: [
        { team_id: 'team_a', name: 'Team A', worker_url: 'https://a.dev', domain: null, mcp_endpoint: null, created_at: '', projects: [] },
        { team_id: 'team_b', name: 'Team B', worker_url: 'https://b.dev', domain: null, mcp_endpoint: null, created_at: '', projects: [] },
      ],
    },
    isLoading: false,
  }),
  useTeamProjects: () => ({ data: { projects: [] }, isLoading: false }),
  useSetProjectMembership: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useJoinTeam: () => ({ mutateAsync: async () => ({}), isPending: false }),
  isTokenMissing: () => false,
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: undefined }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-team-members', () => ({
  useTeamMembers: () => ({
    data: {
      members: [
        {
          id: 'm1',
          user: 'Alice',
          role: 'owner',
          joined: '2026-04-01',
          tags: ['core'],
          machine_id: 'machine-1',
          synced_at: 1779000000,
        },
        {
          id: 'm',
          user: 'm',
          role: null,
          joined: '2026-05-17',
          tags: [],
          machine_id: 'm',
          synced_at: null,
        },
      ],
    },
    isLoading: false,
  }),
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
  beforeEach(() => {
    window.localStorage.clear();
    lastStatusTeamId = undefined;
  });
  it('renders the Teams selection tab by default', async () => {
    render(wrap('/g/foo/team'));
    await waitFor(() => expect(screen.getByText('Registered teams')).toBeInTheDocument());
    expect(screen.getByText('Team A')).toBeInTheDocument();
  });
  it('renders Status tab when a team is selected (?tab=status&team=)', async () => {
    render(wrap('/g/foo/team?tab=status&team=team_a'));
    await waitFor(() => expect(screen.getByText(/Team Credentials/i)).toBeInTheDocument());
  });
  it('renders Sync tab when a team is selected (?tab=sync&team=)', async () => {
    render(wrap('/g/foo/team?tab=sync&team=team_a'));
    await waitFor(() => expect(screen.getByText(/Remote store/i)).toBeInTheDocument());
  });
  it('renders Members roster when a team is selected (?tab=members&team=)', async () => {
    render(wrap('/g/foo/team?tab=members&team=team_a'));
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('machine-1')).toBeInTheDocument();
  });
  it('flags the local machine and hides the inbound-sync chip for self', async () => {
    render(wrap('/g/foo/team?tab=members&team=team_a'));
    await waitFor(() => expect(screen.getByText('this machine')).toBeInTheDocument());
    // Peer row still shows "last received <ago>"; self row must not.
    const lastReceived = screen.queryAllByText(/last received/);
    expect(lastReceived).toHaveLength(1);
  });
  it('auto-selects the first team on a team-scoped tab when none is chosen', async () => {
    render(wrap('/g/foo/team?tab=sync'));
    // No ?team= → the first team is auto-selected and its status is fetched;
    // the empty state is NOT shown.
    await waitFor(() => expect(lastStatusTeamId).toBe('team_a'));
    expect(screen.queryByText(/Select a team to view sync status/i)).not.toBeInTheDocument();
  });
  it('fetches status for the auto-selected first team', async () => {
    render(wrap('/g/foo/team?tab=status'));
    await waitFor(() => expect(lastStatusTeamId).toBe('team_a'));
  });
  it('redirects /team/maintenance → /team?tab=sync with the first team auto-selected', async () => {
    render(wrapWithRoutes('/g/foo/team/maintenance'));
    // The redirect lands on the Sync tab; the first team is auto-selected.
    await waitFor(() => expect(lastStatusTeamId).toBe('team_a'));
  });
  it('auto-selects the first team and honors an explicit change', async () => {
    render(wrap('/g/foo/team?tab=status'));
    const selector = await screen.findByLabelText('Selected team');
    // No ?team= → first team auto-selected (populated, not an empty state).
    expect((selector as HTMLSelectElement).value).toBe('team_a');
    await waitFor(() => expect(lastStatusTeamId).toBe('team_a'));
    fireEvent.change(selector, { target: { value: 'team_b' } });
    await waitFor(() => expect(lastStatusTeamId).toBe('team_b'));
    // The explicit choice persists for the next visit within the section.
    expect(window.localStorage.getItem('myco.team.selectedTeamId')).toBe('team_b');
  });
  it('restores the persisted selection over the first team', async () => {
    window.localStorage.setItem('myco.team.selectedTeamId', 'team_b');
    render(wrap('/g/foo/team?tab=status'));
    const selector = await screen.findByLabelText('Selected team');
    expect((selector as HTMLSelectElement).value).toBe('team_b');
    await waitFor(() => expect(lastStatusTeamId).toBe('team_b'));
  });
});
