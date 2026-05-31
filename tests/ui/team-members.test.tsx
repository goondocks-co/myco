// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import { MembersTab } from '../../packages/myco/ui/src/pages/Team/MembersTab';

const MEMBERS = { members: [
  { id: 'tm1', user: 'alice', role: 'owner', joined: '2026-05-01', tags: [], machine_id: 'm1', synced_at: 1780000000 },
  { id: 'tm2', user: 'bob', role: null, joined: null, tags: [], machine_id: 'm2', synced_at: 1780000100 },
] };

let membersUrl = '';
beforeEach(() => {
  membersUrl = '';
  // @ts-expect-error — test scaffold
  globalThis.fetch = mock(async (url: string) => {
    if (typeof url === 'string' && url.includes('/team/members')) {
      membersUrl = url;
      return new Response(JSON.stringify(MEMBERS), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/team/status')) {
      return new Response(JSON.stringify({ machine_id: 'm1' }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});

function renderMembers(teamId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <MembersTab teamId={teamId} />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('MembersTab', () => {
  it('requests the selected team roster and renders all members', async () => {
    renderMembers('team_x');
    await screen.findByText('alice');
    expect(screen.getByText('bob')).toBeDefined();
    await waitFor(() => expect(membersUrl).toContain('team_id=team_x'));
  });
});
