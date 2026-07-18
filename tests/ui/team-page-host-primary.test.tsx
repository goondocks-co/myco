// @vitest-environment jsdom

/**
 * Team page transition (consolidation Task D-2, completed in E-2): Team Host
 * membership (`HostTab`) is the page's ONLY content — the legacy TEAM SYNC
 * flow (Teams/Status/Sync/Members) has been removed. These tests pin the
 * Host content rendering unconditionally and the affiliation-hint banner
 * behavior.
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

describe('Team page — Host-primary', () => {
  it('renders the Host content unconditionally, with no legacy Team Sync remnants', async () => {
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('Join a Team Host')).toBeInTheDocument());
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
    expect(screen.queryByText('Team Sync')).not.toBeInTheDocument();
    expect(screen.queryByText('Registered teams')).not.toBeInTheDocument();
  });

  it('surfaces the affiliation hint as a CTA banner when present, mapped to UI voice — never the CLI-voiced wire message', async () => {
    hostMembershipHint = { host_id: 'host_abc', state: 'not_joined', message: 'This project is served by Team Host host_abc — run `myco join host_abc` to enroll this machine, then attach this project.' };
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('This project is affiliated with a Team Host')).toBeInTheDocument());
    expect(screen.getByText(/join it using the form below to route the project there/)).toBeInTheDocument();
    const rendered = screen.getByRole('status').textContent ?? '';
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain('myco ');
  });

  it('renders no hint banner when the hint is null (resolved or absent)', async () => {
    hostMembershipHint = null;
    renderTeamPage();

    await waitFor(() => expect(screen.getByText('Join a Team Host')).toBeInTheDocument());
    expect(screen.queryByText('This project is affiliated with a Team Host')).not.toBeInTheDocument();
  });
});
