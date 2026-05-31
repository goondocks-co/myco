// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import { TeamSelection } from '../../packages/myco/ui/src/pages/Team/TeamSelection';

const TEAM = {
  team_id: 'team_abc',
  name: 'Acme Core',
  worker_url: 'https://acme.workers.dev',
  domain: null,
  mcp_endpoint: null,
  created_at: '2026-05-01',
  projects: [{ grove_id: 'g1', project_id: 'p1' }],
  has_deployment: false,
};

const REGISTRY = { teams: [TEAM] };

const PROJECTS = {
  projects: [
    { grove_id: 'g1', grove_name: 'Main Grove', project_id: 'p1', project_name: 'Synced Project', team_id: 'team_abc' },
    { grove_id: 'g1', grove_name: 'Main Grove', project_id: 'p2', project_name: 'Unsynced Project', team_id: null },
  ],
};

beforeEach(() => {
  // @ts-expect-error — test scaffold
  globalThis.fetch = mock(async (url: string) => {
    if (typeof url === 'string' && url.includes('/team/registry')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/team/projects')) {
      return new Response(JSON.stringify(PROJECTS), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});

function renderSelection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <TeamSelection />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('TeamSelection', () => {
  it('renders the registered team name and worker url', async () => {
    renderSelection();
    // The worker_url is unique to the team row; the team name also appears as a
    // <select> option, so assert via getAllByText for the name.
    await screen.findByText('https://acme.workers.dev');
    expect(screen.getAllByText('Acme Core').length).toBeGreaterThan(0);
    expect(screen.getByText('https://acme.workers.dev')).toBeDefined();
  });

  it('renders one row per project', async () => {
    renderSelection();
    await screen.findByText('Synced Project');
    expect(screen.getByText('Synced Project')).toBeDefined();
    expect(screen.getByText('Unsynced Project')).toBeDefined();
  });

  it('joins a team from the worker URL + key form', async () => {
    const joinCalls: Array<Record<string, unknown>> = [];
    // @ts-expect-error — test scaffold
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/team/join')) {
        joinCalls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ team: TEAM }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/team/registry')) return new Response(JSON.stringify(REGISTRY), { status: 200 });
      if (typeof url === 'string' && url.includes('/team/projects')) return new Response(JSON.stringify(PROJECTS), { status: 200 });
      return new Response('{}', { status: 200 });
    });

    renderSelection();
    const urlInput = await screen.findByLabelText('Worker URL');
    const keyInput = screen.getByLabelText('Team key');
    fireEvent.change(urlInput, { target: { value: 'https://new.workers.dev' } });
    fireEvent.change(keyInput, { target: { value: 'tk-123' } });
    fireEvent.click(screen.getByRole('button', { name: /join team/i }));

    await waitFor(() => expect(joinCalls.length).toBe(1));
    expect(joinCalls[0]).toEqual({ worker_url: 'https://new.workers.dev', team_key: 'tk-123' });
  });

  it('hides the update command for joined (non-admin) teams and shows Leave team', async () => {
    renderSelection();
    await screen.findByText('https://acme.workers.dev');
    expect(screen.queryByText(/Update command/i)).toBeNull();
    expect(screen.getByRole('button', { name: /leave team/i })).toBeDefined();
  });

  it('shows the update command for teams with a deployment', async () => {
    const ADMIN_REGISTRY = { teams: [{ ...TEAM, has_deployment: true }] };
    // @ts-expect-error — test scaffold
    globalThis.fetch = mock(async (url: string) => {
      if (typeof url === 'string' && url.includes('/team/registry')) return new Response(JSON.stringify(ADMIN_REGISTRY), { status: 200 });
      if (typeof url === 'string' && url.includes('/team/projects')) return new Response(JSON.stringify(PROJECTS), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderSelection();
    await screen.findByText(/Update command/i);
  });

  it('leaves a team via the forget endpoint', async () => {
    const forgetCalls: Array<Record<string, unknown>> = [];
    // @ts-expect-error — test scaffold
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/team/forget')) {
        forgetCalls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ forgotten: true }), { status: 200 });
      }
      if (typeof url === 'string' && url.includes('/team/registry')) return new Response(JSON.stringify(REGISTRY), { status: 200 });
      if (typeof url === 'string' && url.includes('/team/projects')) return new Response(JSON.stringify(PROJECTS), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    renderSelection();
    fireEvent.click(await screen.findByRole('button', { name: /leave team/i }));
    await waitFor(() => expect(forgetCalls.length).toBe(1));
    expect(forgetCalls[0]).toEqual({ team_id: 'team_abc' });
  });

  it('preselects the team for a synced project and "Not synced" for an unassigned one', async () => {
    renderSelection();
    await screen.findByText('Synced Project');
    await waitFor(() => {
      const syncedSelect = screen.getByLabelText('Team for Synced Project') as HTMLSelectElement;
      expect(syncedSelect.value).toBe('team_abc');
    });
    const unsyncedSelect = screen.getByLabelText('Team for Unsynced Project') as HTMLSelectElement;
    expect(unsyncedSelect.value).toBe('');
  });
});
