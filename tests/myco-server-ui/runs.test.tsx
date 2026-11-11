import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RUN_FAILURE_WORDS } from '@goondocks/myco-shared/run-control';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import type { RunHoursAnswer } from '../../packages/myco-server/ui/src/features/runs/RunsPage';
import { dashboardMe } from '../helpers/dashboard-permissions';

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); globalThis.fetch = originalFetch; });
const HOUR = 3_600_000;
const UNTIL = Math.floor(Date.now() / HOUR) * HOUR + HOUR;
const SINCE = UNTIL - 24 * HOUR;
const counts = (worked: number, unchanged: number, failed: number) => ({ worked, unchanged, failed });
const HOURS: RunHoursAnswer = {
  window: { name: 'day', since: SINCE, until: UNTIL, sliceMs: HOUR }, counted: true,
  totals: { ...counts(3, 1, 3), waitedMs: 0 },
  lanes: [{ runnerId: 'rn_mini', name: 'homelab-mini', hours: [{ hour: SINCE, ...counts(3, 1, 2) }, { hour: UNTIL - 3 * HOUR, ...counts(0, 0, 1) }] }],
  failures: {
    cause: [{ key: 'machine_unresponsive', name: null, runs: 3, prior: 1, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR }],
    runner: [{ key: 'rn_mini', name: 'homelab-mini', runs: 3, prior: 0, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR },
      { key: null, name: null, runs: 1, prior: 0, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR }],
    agent: [], task: [],
  },
};
const RUN = { projectId: 'proj_1', projectName: 'Myco', runId: 'run_1', task: 'embedding-reconcile', result: 'failed', errorCode: 'machine_unresponsive',
  harness: 'claude-code', model: null, runner: { id: 'rn_mini', name: 'homelab-mini' }, completedAt: UNTIL - 3 * HOUR };

function mount(route = '/runs', finished: (cursor: string | null) => unknown = () => ({ rows: [RUN], cursor: null })) {
  const asked: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://s');
    if (url.pathname === '/auth/me') return Response.json(dashboardMe({ sub: '1', login: 'owner', member: { id: 'mem_1', label: 'Chris', role: 'admin' } }));
    if (url.pathname === '/api/runs/hours') return Response.json(HOURS);
    if (url.pathname === '/api/runs/finished') { asked.push(url.search); return Response.json(finished(url.searchParams.get('cursor'))); }
    if (url.pathname === '/api/projects') return Response.json({ projects: [] });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[route]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return asked;
}

describe('Runs page', () => {
  it('shows when runs finished per runner with the quiet spells, what is failing with its trend, and every run linked to its panel and runner', async () => {
    mount();
    expect((await screen.findByText(/7 runs finished in the last 24 hours/)).textContent).toBe('7 runs finished in the last 24 hours: 3 worked, 1 changed nothing, 3 failed.');
    const timeline = screen.getByRole('region', { name: 'When runs finished' });
    expect(within(timeline).getByRole('link', { name: 'homelab-mini' }).getAttribute('href')).toBe('/runners/rn_mini');
    expect(within(timeline).getByText(/^Nothing finished .*\(20 hours\)$/)).toBeTruthy();

    const failing = screen.getByRole('region', { name: 'What’s failing' });
    const group = within(failing).getByRole('link', { name: new RegExp(RUN_FAILURE_WORDS.machine_unresponsive!.slice(0, 20)) });
    expect(group.textContent).toContain('3 failed runs · Up from 1 the day before');
    expect(group.getAttribute('href')).toBe('/runs?outcome=failed&cause=machine_unresponsive#runs-all');
    fireEvent.click(within(failing).getByRole('button', { name: 'Runner' }));
    expect(within(failing).getByRole('link', { name: /homelab-mini/ }).textContent).toContain('New: none the day before');
    expect(within(failing).getByRole('link', { name: /No runner/ }).getAttribute('href')).toBe('/runs?group=runner&outcome=failed&noRunner=1#runs-all');

    const all = screen.getByRole('region', { name: 'All runs' });
    const row = await within(all).findByRole('link', { name: /A search index update · Myco/ });
    expect(row.getAttribute('href')).toBe('/p/proj_1/work/runs/run_1');
    expect(row.textContent).toContain(`Failed · ${RUN_FAILURE_WORDS.machine_unresponsive}`);
    expect(within(all).getByRole('link', { name: 'homelab-mini' }).getAttribute('href')).toBe('/runners/rn_mini');
  });

  it('narrows the runs to a failure group and clears the narrowing', async () => {
    const asked = mount('/runs?outcome=failed&cause=machine_unresponsive');
    const all = await screen.findByRole('region', { name: 'All runs' });
    await waitFor(() => expect(asked.at(-1)).toBe('?window=day&outcome=failed&cause=machine_unresponsive'));
    fireEvent.click(within(all).getByRole('button', { name: /Its time limit passed/ }));
    await waitFor(() => expect(asked.at(-1)).toBe('?window=day&outcome=failed'));
  });

  it('keeps looking when a page checked its share of runs and found none yet', async () => {
    const asked = mount('/runs?outcome=failed&cause=machine_unresponsive&runner=rn_mini', (cursor) => cursor === null ? { rows: [], cursor: 'next' } : { rows: [RUN], cursor: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep looking' }));
    expect((await screen.findByRole('link', { name: /A search index update · Myco/ })).getAttribute('href')).toBe('/p/proj_1/work/runs/run_1');
    expect(asked.at(-1)).toContain('cursor=next');
  });
});
