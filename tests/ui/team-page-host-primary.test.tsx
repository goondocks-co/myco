// @vitest-environment jsdom

/**
 * Team page transition (consolidation Task D-2): Team Host membership
 * (`HostTab`) is the PRIMARY, unconditional content; the legacy TEAM SYNC
 * flow (Teams/Status/Sync/Members) demotes to a clearly-marked "Legacy"
 * section visible ONLY when team sync is already configured on this machine
 * (`teams.length > 0`) — never two competing "join a team" stories at equal
 * prominence. `tests/ui/team-tabs.test.tsx` covers the demoted legacy tabs'
 * own behavior (already-configured case); these tests pin the TRANSITION
 * itself — what appears/disappears as `teams.length` crosses zero.
 */
import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

let registryTeams: Array<{ team_id: string; name: string; worker_url: string; domain: null; mcp_endpoint: null; created_at: string; projects: never[] }> = [];

mock.module('../../packages/myco/ui/src/hooks/use-team', () => ({
  useTeamStatus: () => ({ data: undefined, isLoading: false }),
  useTeamQueueStats: () => ({ data: undefined, isLoading: false }),
  useTeamSyncSummary: () => ({ data: undefined, isLoading: false }),
  useTeamDlq: () => ({ data: undefined, isLoading: false }),
  useTeamRegistry: () => ({ data: { teams: registryTeams }, isLoading: false }),
  useTeamProjects: () => ({ data: { projects: [] }, isLoading: false }),
  useSetProjectMembership: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useJoinTeam: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useForgetTeam: () => ({ mutateAsync: async () => ({}), isPending: false }),
  isTokenMissing: () => false,
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: undefined }),
}));

let hostMembershipHint: { host_id: string; state: string; message: string } | null = null;

mock.module('../../packages/myco/ui/src/hooks/use-host-membership', () => ({
  useHostMembershipStatus: () => ({ data: { hosts: [], hint: hostMembershipHint }, isLoading: false }),
  useJoinHost: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useLeaveHost: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useAttachProject: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDetachProject: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDrainHealth: () => ({ data: { hosts: [] }, isLoading: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: { groves: [] }, isLoading: false }),
}));

import { TeamPage } from '../../packages/myco/ui/src/pages/Team';

function renderTeamPage(initial = '/g/foo/team') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initial]}>
          <TeamPage />
        </MemoryRouter>
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('Team page — Host-primary transition', () => {
  it('with no team sync configured, renders ONLY the Host content — no legacy section, no "Registered teams" onboarding', async () => {
    registryTeams = [];
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('Join a Team Host')).toBeInTheDocument());
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText('Team Sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Registered teams')).not.toBeInTheDocument();
  });

  it('with team sync already configured, renders Host content AND the demoted legacy section', async () => {
    registryTeams = [{ team_id: 'team_a', name: 'Team A', worker_url: 'https://a.dev', domain: null, mcp_endpoint: null, created_at: '', projects: [] }];
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('Join a Team Host')).toBeInTheDocument());
    expect(screen.getByText('Legacy')).toBeInTheDocument();
    expect(screen.getByText('Team Sync')).toBeInTheDocument();
    // Default legacy tab (Teams) content is reachable below the Host content.
    await waitFor(() => expect(screen.getByText('Registered teams')).toBeInTheDocument());
  });

  it('surfaces the affiliation hint as a CTA banner when present, mapped to UI voice — never the CLI-voiced wire message', async () => {
    registryTeams = [];
    hostMembershipHint = { host_id: 'host_abc', state: 'not_joined', message: 'This project is served by Team Host host_abc — run `myco join host_abc` to enroll this machine, then attach this project.' };
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('This project is affiliated with a Team Host')).toBeInTheDocument());
    expect(screen.getByText(/join it using the form below to route the project there/)).toBeInTheDocument();
    const rendered = screen.getByRole('status').textContent ?? '';
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('myco ');
  });

  it('renders no hint banner when the hint is null (resolved or absent)', async () => {
    registryTeams = [];
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('Join a Team Host')).toBeInTheDocument());
    expect(screen.queryByText('This project is affiliated with a Team Host')).not.toBeInTheDocument();
  });
});
