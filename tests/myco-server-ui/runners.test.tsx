import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { dashboardMe } from '../helpers/dashboard-permissions';
import type { RunnerRow } from '../../packages/myco-server/ui/src/lib/api';

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); globalThis.fetch = originalFetch; });
const NOW = Date.now();
const RUNNER: RunnerRow = { id: 'rn_mini', name: 'homelab-mini', state: 'enabled', connected: true, version: '2.0.0-alpha.2', channel: 'alpha', latestVersion: '2.0.0-alpha.3', lastSeenAt: NOW, lastCheckAt: NOW,
  lastResult: { fromVersion: '2.0.0-alpha.1', toVersion: '2.0.0-alpha.2', result: 'updated', at: NOW }, updateRequest: null, busy: null };

function mount(role: 'admin' | 'member', initial: RunnerRow = RUNNER) {
  let runner = initial;
  const writes: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, 'https://s').pathname;
    if (path === '/auth/me') return Response.json(dashboardMe({ sub: '1', login: 'owner', member: { id: 'mem_1', label: 'Chris', role } }));
    if (path === '/api/projects') return Response.json({ projects: [] });
    if (path === '/api/status') return Response.json({ schema: { expected: 80, found: 80, matches: true }, capabilities: [], projects: [], workers: { available: true, fleet: [], runsQueued: 0, workersBusy: 0 } });
    if (path === '/api/runners') return Response.json({ runners: [runner] });
    if (path === '/api/runners/rn_mini/update') {
      writes.push(`${init?.method} ${path}`);
      runner = { ...runner, updateRequest: { id: 'request_1', requestedAt: NOW } };
      return Response.json({ requested: true, updateRequest: runner.updateRequest });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/runners']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return writes;
}

describe('Runners page', () => {
  it('shows reported version, channel, available update and last result, and requests the next idle update', async () => {
    const writes = mount('admin', { ...RUNNER, busy: { projectId: 'proj_1', runId: 'run_1', leaseExpiresAt: NOW + 60000 } });
    const article = (await screen.findByText('homelab-mini')).closest('article');
    expect(article?.textContent).toContain('Connected');
    expect(article?.textContent).toContain('2.0.0-alpha.2');
    expect(article?.textContent).toContain('alpha');
    expect(article?.textContent).toContain('Update available: 2.0.0-alpha.3');
    expect(article?.textContent).toContain('Updated');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(writes.length).toBe(1));
    await waitFor(() => expect(screen.getByText('homelab-mini').closest('article')?.textContent).toContain('waiting for the current run to finish'));
    expect(writes).toEqual(['POST /api/runners/rn_mini/update']);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('keeps the page and runner reports readable to a member without update controls', async () => {
    const writes = mount('member');
    await screen.findByText('homelab-mini');
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Runners' })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('disables update for an offline runner or one that cannot report its installed release channel', async () => {
    for (const runner of [{ ...RUNNER, connected: false }, { ...RUNNER, channel: null }]) {
      const writes = mount('admin', runner);
      const article = (await screen.findByText('homelab-mini')).closest('article');
      expect((await within(article!).findByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(true);
      expect(writes).toEqual([]);
      cleanup();
      clients.splice(0).forEach(client => client.clear());
    }
  });
});
