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
/** Every hour of the window, oldest first. */
const EVERY_HOUR = Array.from({ length: 24 }, (_, i) => SINCE + i * HOUR);
const HOURS: RunHoursAnswer = {
  window: { name: 'day', since: SINCE, until: UNTIL, sliceMs: HOUR }, counted: true,
  totals: { ...counts(3, 1, 3), waitedMs: 0 },
  lanes: [
    { runnerId: 'rn_mini', name: 'homelab-mini', hours: [{ hour: SINCE, ...counts(3, 1, 2) }, { hour: UNTIL - 3 * HOUR, ...counts(0, 0, 1) }], checkins: EVERY_HOUR },
    { runnerId: 'rn_studio', name: 'studio-m4', hours: [], checkins: EVERY_HOUR.filter((_, i) => i % 2 === 0) },
  ],
  recordedSince: SINCE, waits: [], stillWaiting: [],
  failures: {
    cause: [{ key: 'machine_unresponsive', name: null, runs: 3, prior: 1, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR }],
    runner: [{ key: 'rn_mini', name: 'homelab-mini', runs: 3, prior: 0, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR },
      { key: null, name: null, runs: 1, prior: 0, slices: Array(24).fill(0), latestHour: UNTIL - 3 * HOUR }],
    agent: [], task: [],
  },
};
const RUN = { projectId: 'proj_1', projectName: 'Myco', runId: 'run_1', task: 'embedding-reconcile', result: 'failed', errorCode: 'machine_unresponsive',
  harness: 'claude-code', model: null, runner: { id: 'rn_mini', name: 'homelab-mini' }, completedAt: UNTIL - 3 * HOUR };

function mount(route = '/runs', finished: (cursor: string | null) => unknown = () => ({ rows: [RUN], cursor: null }), hours: RunHoursAnswer = HOURS) {
  const asked: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://s');
    if (url.pathname === '/auth/me') return Response.json(dashboardMe({ sub: '1', login: 'owner', member: { id: 'mem_1', label: 'Chris', role: 'admin' } }));
    if (url.pathname === '/api/runs/hours') return Response.json(hours);
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

  it('shows each runner’s check-ins beneath its runs, a runner that only checked in included', async () => {
    mount();
    const timeline = await screen.findByRole('region', { name: 'When runs finished' });
    expect(within(timeline).getByRole('img', { name: 'homelab-mini checked in during 24 of 24' })).toBeTruthy();
    expect(within(timeline).getByRole('link', { name: 'studio-m4' }).getAttribute('href')).toBe('/runners/rn_studio');
    expect(within(timeline).getByRole('img', { name: 'studio-m4 checked in during 12 of 24' })).toBeTruthy();
    expect(within(timeline).getByRole('img', { name: /^studio-m4: 0 worked, 0 changed nothing, 0 failed; nothing finished in 24 of 24$/ })).toBeTruthy();
  });

  /** The 20-hour quiet spell of the fixture, opened. */
  const openSpell = async () => {
    const timeline = await screen.findByRole('region', { name: 'When runs finished' });
    fireEvent.click(within(timeline).getByRole('button', { name: /^Nothing finished .*\(20 hours\)$/ }));
    return within(timeline).getByRole('group', { name: /^Nothing finished .*\(20 hours\)$/ });
  };

  it('reads a quiet spell as normal when nothing waited and runners checked in', async () => {
    mount();
    const spell = await openSpell();
    expect(within(spell).getByText('Looks normal')).toBeTruthy();
    expect(within(spell).getByText('Looks normal: nothing was waiting, 2 runners checked in')).toBeTruthy();
    expect(within(spell).getByText('homelab-mini and studio-m4 checked in.')).toBeTruthy();
  });

  it('reads a quiet spell as worth a look when runs waited through it, or work queued before it still waits', async () => {
    mount('/runs', undefined, { ...HOURS, waits: [
      { queuedHour: SINCE + 2 * HOUR, takenHour: SINCE + 5 * HOUR, runs: 7 },
      { queuedHour: SINCE + 3 * HOUR, takenHour: UNTIL - 3 * HOUR, runs: 2 },
      { queuedHour: SINCE, takenHour: SINCE, runs: 4 },
    ] });
    const spell = await openSpell();
    expect(within(spell).getByText('Worth a look')).toBeTruthy();
    expect(within(spell).getByText('Worth a look: 9 runs waited')).toBeTruthy();
    cleanup();
    mount('/runs', undefined, { ...HOURS, stillWaiting: [{ since: SINCE + 4 * HOUR, runs: 3 }] });
    const still = await openSpell();
    expect(within(still).getByText('Worth a look: work queued before it ended still waits')).toBeTruthy();
    expect(within(still).getByText('Work queued before it ended still waits: 3 runs queued now.')).toBeTruthy();
  });

  it('reads a quiet spell as worth a look when no runner checked in, and gives no reading before check-ins were recorded', async () => {
    mount('/runs', undefined, { ...HOURS, lanes: HOURS.lanes.map((lane) => ({ ...lane, checkins: lane.checkins.filter((hour) => hour < SINCE + HOUR || hour >= UNTIL - 3 * HOUR) })) });
    expect(within(await openSpell()).getByText('Worth a look: no runner checked in')).toBeTruthy();
    cleanup();
    mount('/runs', undefined, { ...HOURS, recordedSince: UNTIL - 2 * HOUR });
    const unrecorded = await openSpell();
    expect(within(unrecorded).getByText(/^Not recorded: Myco keeps check-ins and waits from /)).toBeTruthy();
    expect(within(unrecorded).queryByText('Looks normal')).toBeNull();
    expect(within(unrecorded).queryByText('Worth a look')).toBeNull();
  });
});
