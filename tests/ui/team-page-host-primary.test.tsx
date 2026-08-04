// @vitest-environment jsdom

/**
 * The Team page's CONNECTED shell (E1 §5): once this machine has joined a
 * host, Tab 1 ("Team") is the Team Host membership content and nothing of the
 * retired TEAM SYNC flow (Teams/Status/Sync/Members) survives. The
 * affiliation-hint banner is HostTab's own, but it only reaches a user
 * THROUGH that tab — so these tests drive it through the real page
 * composition rather than the component in isolation.
 *
 * The unconnected branch (the fork) is pinned in tests/ui/host-tab.test.tsx.
 */
import { describe, it, expect, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: undefined }),
}));

let hostMembershipHint: { host_id: string; state: string; message: string } | null = null;

// A joined host is what makes the page connected — the shell renders the fork
// instead until either this read has a host or the machine is serving.
const JOINED_HOST = {
  host_id: 'host_abc', label: 'Mac Studio', host_url: 'https://host-a.tailnet.ts.net:8443',
  protocol_version: 1, created_at: '2026-01-01T00:00:00Z', projects: [],
};

mock.module('../../packages/myco/ui/src/hooks/use-host-membership', () => ({
  useHostMembershipStatus: () => ({ data: { hosts: [JOINED_HOST], hint: hostMembershipHint }, isLoading: false }),
  useJoinHost: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useLeaveHost: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useAttachProject: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDetachProject: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDrainHealth: () => ({ data: { hosts: [] }, isLoading: false }),
  useHostMembershipHealth: () => ({ data: { hosts: [] }, isLoading: false, isFetching: false, refetch: () => {} }),
  useResidencyStatus: () => ({ data: undefined }),
  useResidencyAbort: () => ({ mutateAsync: async () => ({}), isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-host-serve-status', () => ({
  useHostServeStatus: () => ({ data: { serving: false } }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-host-admin', () => ({
  useHostAdminEnable: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useHostAdminDisable: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useMintJoinKey: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useHostAdminProgress: () => ({ data: null, isFetched: false }),
  useHostServePhase2: () => ({ data: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: { groves: [] }, isLoading: false }),
}));

import { TeamPage } from '../../packages/myco/ui/src/pages/Team';

function renderTeamPage(initial = '/team') {
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

describe('Team page — Host-primary', () => {
  it('renders the Host content under the Team tab, with no legacy Team Sync remnants', async () => {
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Team' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('1 host')).toBeInTheDocument();
    expect(screen.getByText('Route a project through a Team Host')).toBeInTheDocument();
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText('Team Sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Registered teams')).not.toBeInTheDocument();
  });

  it('surfaces the affiliation hint as a CTA banner when present, mapped to UI voice — never the CLI-voiced wire message', async () => {
    hostMembershipHint = { host_id: 'host_abc', state: 'not_joined', message: 'This project is served by Team Host host_abc — run `myco join host_abc` to enroll this machine, then attach this project.' };
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('This project is affiliated with a Team Host')).toBeInTheDocument());
    expect(screen.getByText(/join it using the form below to route the project there/)).toBeInTheDocument();
    const banner = screen.getByText('This project is affiliated with a Team Host').closest('[role="status"]');
    const rendered = banner?.textContent ?? '';
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('myco ');
  });

  it('renders no hint banner when the hint is null (resolved or absent)', async () => {
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('1 host')).toBeInTheDocument());
    expect(screen.queryByText('This project is affiliated with a Team Host')).not.toBeInTheDocument();
  });
});
