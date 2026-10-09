import { QUEUE_REASON_WORDS, type FleetQueue } from '@goondocks/myco-shared/runner-fleet';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { dashboardMe } from '../helpers/dashboard-permissions';
import type { RunnerRow, WorkerRow } from '../../packages/myco-server/ui/src/lib/api';

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); globalThis.fetch = originalFetch; });
const NOW = Date.now();
const RUNNER: RunnerRow = { id: 'rn_mini', name: 'homelab-mini', state: 'enabled', connected: true, version: '2.0.0-alpha.2', channel: 'alpha', latestVersion: '2.0.0-alpha.3', updateAvailable: true, lastSeenAt: NOW, lastCheckAt: NOW, offersObservedAt: NOW,
  display: 'Online', revision: 1, createdAt: NOW, createdBy: 'mem_1', removedAt: null, os: 'macOS', arch: 'arm64', readiness: { state: 'ready', reason: 'Reports a signed-in agent; provider access is untested.', observedAt: NOW }, offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], labels: [], preference: null, models: [], lastReason: 'no_work', lastAttempted: null, lastCompleted: null, lastFailed: null,
  lastResult: { fromVersion: '2.0.0-alpha.1', toVersion: '2.0.0-alpha.2', result: 'updated', at: NOW }, blockedVersion: null, updateState: null, updateRequest: null, busy: null };

function mount(role: 'admin' | 'member', initial: RunnerRow = RUNNER,
  options: { rows?: RunnerRow[]; legacy?: WorkerRow[]; fail?: boolean; route?: string; queue?: FleetQueue; previewName?: string; previewRunnerId?: string } = {}) {
  let runner = initial;
  const writes: string[] = [];
  let legacy = options.legacy ?? [];
  globalThis.fetch = (async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(href, 'https://s').pathname;
    if (path === '/auth/me') return Response.json(dashboardMe({ sub: '1', login: 'owner', member: { id: 'mem_1', label: 'Chris', role } }));
    if (path === '/api/machines') return Response.json({ machines: [] });
    if (path === '/api/members') return Response.json({ members: [] });
    if (path === '/api/projects') return Response.json({ projects: [] });
    if (path === '/api/status') return Response.json({ schema: { expected: 80, found: 80, matches: true }, capabilities: [], projects: [], workers: { available: true, fleet: legacy, runsQueued: 0, workersBusy: 0 } });
    if (path === '/api/runners') return options.fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ observedAt: NOW, runners: options.rows ?? [runner], legacyWorkers: legacy, queue: options.queue ?? { observedAt: NOW, count: 0, oldestAt: null, reasons: [], nativeNeedsRunner: false } });
    if (path === '/api/device/preview') return Response.json({ subject: 'runner', runnerName: options.previewName ?? 'homelab-mini', replacingRunnerId: options.previewRunnerId ?? 'rn_mini', machineName: 'Mini in the office', os: 'macOS', ip: '192.0.2.1', approverIp: '192.0.2.2', ageSeconds: 12, scope: 'runner', expiresAt: NOW + 60000 });
    if (path === '/api/runners/rn_mini/update') {
      writes.push(`${init?.method} ${path}`);
      runner = { ...runner, updateRequest: { id: 'request_1', requestedAt: NOW, clearBlock: true } };
      return Response.json({ requested: true, updateRequest: runner.updateRequest });
    }
    if (path.endsWith('/forget')) { writes.push(`${init?.method} ${path}`); legacy = []; return Response.json({ forgotten: true }); }
    if (path.startsWith('/api/runners/rn_mini/')) { writes.push(`${init?.method} ${path}`); return Response.json({ changed: true }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[options.route ?? '/runners']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return writes;
}

describe('Runners page', () => {
  it('shows reported version, channel, available update and last result, and requests the next idle update', async () => {
    const writes = mount('admin', { ...RUNNER, busy: { projectId: 'proj_1', projectName: 'Myco', task: 'title-summary', at: NOW, status: 'running', runId: 'run_1', leaseExpiresAt: NOW + 60000 } });
    const article = (await screen.findByText('homelab-mini')).closest('article');
    expect(article?.textContent).toContain('Writing a title for Myco');
    expect(article?.textContent).toContain('2.0.0-alpha.2');
    expect(article?.textContent).toContain('Update available');
    expect(article?.querySelector('details')?.open).toBe(false);
    expect(article?.querySelector('details')?.textContent).toContain('2.0.0-alpha.3');
    expect(article?.textContent).toContain('Updated');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Update now' }));
    await waitFor(() => expect(writes.length).toBe(1));
    await waitFor(() => expect(screen.getByText('homelab-mini').closest('article')?.textContent).toContain('waiting for the current task to finish'));
    expect(writes).toEqual(['POST /api/runners/rn_mini/update']);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Update now' }) as HTMLButtonElement).disabled).toBe(true));
  });

  it('keeps the page and runner reports readable to a member without update controls', async () => {
    const writes = mount('member');
    await screen.findByText('homelab-mini');
    for (const name of ['Update now', 'More actions for homelab-mini', 'Rename', 'Pause', 'Remove', 'Replace registration', 'Add runner', 'Forget this worker'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('link', { name: 'Runners' })).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('shows a failed release block, expiry and cleanup state and lets administrators explicitly retry', async () => {
    const blocked = { ...RUNNER, lastResult: { fromVersion: RUNNER.version!, toVersion: RUNNER.latestVersion!, result: 'rolled_back' as const, reason: 'Health check failed', at: NOW },
      blockedVersion: { version: RUNNER.latestVersion!, until: NOW + 3600000, reason: 'Launch failed' }, updateState: { phase: 'cleanup_pending' as const, since: NOW, reason: 'Guardian cleanup failed' } };
    const writes = mount('admin', blocked);
    const article = (await screen.findByText('homelab-mini')).closest('article');
    expect(article?.textContent).toContain('Rolled back');
    expect(article?.textContent).toContain('Health check failed');
    expect(article?.textContent).toContain('Blocked release: 2.0.0-alpha.3');
    expect(article?.textContent).toContain(new Date(blocked.blockedVersion.until).toLocaleString());
    expect(article?.textContent).toContain('Finishing update cleanup');
    expect(article?.textContent).not.toContain('execution held');
    expect(article?.textContent).toContain('Guardian cleanup failed');
    fireEvent.click(screen.getByRole('button', { name: 'Clear block and update' }));
    await waitFor(() => expect(writes.length).toBe(1));
  });

  it('shows updating and probation holds to members without a retry control', async () => {
    for (const [phase, words] of [['updating', 'Updating'], ['probation', 'Checking update health']] as const) {
      mount('member', { ...RUNNER, updateState: { phase, since: NOW, reason: 'Waiting for service health' } });
      const article = (await screen.findByText('homelab-mini')).closest('article');
      expect(article?.textContent).toContain(words);
      expect(article?.textContent).toContain('Waiting for service health');
      expect(screen.queryByRole('button', { name: 'Clear block and update' })).toBeNull();
      cleanup(); clients.splice(0).forEach(client => client.clear());
    }
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
  it('does not offer an update when the reported release is current or older', async () => {
    mount('admin', { ...RUNNER, latestVersion: '2.0.0-alpha.1', updateAvailable: false });
    const article = (await screen.findByText('homelab-mini')).closest('article')!;
    expect(article.textContent).not.toContain('Update available');
    expect(within(article).queryByRole('button', { name: 'Update now' })).toBeNull();
    expect(within(article).getByRole('button', { name: 'More actions for homelab-mini' })).toBeTruthy();
  });
  it('renders every display state, lease without contact, persistent history and unavailable facts', async () => {
    const lease = { projectId: 'proj_1', projectName: 'Myco', task: 'title-summary', at: NOW, status: 'running', runId: 'run_1', leaseExpiresAt: NOW + 60000 };
    const rows: RunnerRow[] = [
      { ...RUNNER, id: 'busy', name: 'Busy machine', display: 'Busy', busy: lease, lastSeenAt: null, connected: false },
      { ...RUNNER, id: 'idle', name: 'Idle machine' },
      { ...RUNNER, id: 'empty', name: 'No agent machine', display: 'Not ready', offers: [], readiness: { state: 'unknown', reason: 'Reported no signed-in eligible agent.', observedAt: NOW } },
      { ...RUNNER, id: 'settling', name: 'Waking machine', display: 'Not ready', readiness: { state: 'settling', reason: 'Waiting to settle after waking.', observedAt: NOW } },
      { ...RUNNER, id: 'paused', name: 'Paused machine', display: 'Paused', state: 'paused', busy: lease },
      { ...RUNNER, id: 'removed', name: 'Removed machine', display: 'Removed', state: 'removed', connected: false },
      { ...RUNNER, id: 'stale', name: 'Stale machine', display: 'Offline', connected: false, lastSeenAt: NOW - 1800000 },
      { ...RUNNER, id: 'never', name: 'New machine', display: 'Never contacted', connected: false, lastSeenAt: null },
      { ...RUNNER, id: 'unknown', name: 'Unknown machine', display: 'Not ready', offers: null, models: [], lastCompleted: { ...lease, status: 'completed' } },
    ];
    mount('member', RUNNER, { rows });
    for (const row of rows) {
      const article = (await screen.findByText(row.name)).closest('article')!;
      expect(article.textContent).toContain(row.display);
      expect(article.textContent).not.toContain('Stopped');
    }
    const busy = screen.getByText('Busy machine').closest('article')!;
    expect(busy.textContent).toContain('Assignment valid until');
    expect(busy.textContent).toContain('Myco');
    expect(screen.getByText('Paused machine').closest('article')!.textContent).toContain('Busy · draining');
    expect(screen.getByText('Unknown machine').closest('article')!.textContent).toContain('Agent sign-in status unavailable');
    expect(screen.getByText('Unknown machine').closest('article')!.textContent).toContain('Last completed');
  });

  it('names readiness holds and keeps removed and paused outcomes ahead of replacement waiting', async () => {
    const holds = [
      ['updating', 'Finishing an update'], ['registration', 'Waiting for registration approval'],
      ['user_active', 'Waiting until the machine is idle'], ['incompatible', 'Agent needs an update'],
      ['not_signed_in', 'No signed-in agent'],
    ] as const;
    const rows: RunnerRow[] = holds.map(([code], index) => ({ ...RUNNER, id: `rn_hold_${index}`, name: `Hold ${index}`, display: 'Not ready', readiness: { state: 'unknown', code, reason: `${code} detail`, observedAt: NOW } }));
    rows.push({ ...RUNNER, id: 'rn_paused', name: 'Paused replacement', state: 'paused', display: 'Paused', awaitingReplacement: true });
    rows.push({ ...RUNNER, id: 'rn_removed', name: 'Removed replacement', state: 'removed', display: 'Removed', awaitingReplacement: true });
    mount('member', RUNNER, { rows });
    for (const [index, [, words]] of holds.entries()) {
      const article = (await screen.findByText(`Hold ${index}`)).closest('article')!;
      expect(article.textContent).toContain(words);
      expect(article.querySelector('details')?.textContent).toContain(`${holds[index][0]} detail`);
    }
    expect(screen.getByText('Paused replacement').closest('article')?.textContent).toContain('Paused — waiting to resume');
    expect(screen.getByText('Removed replacement').closest('article')?.textContent).toContain('Removed — can no longer run work');
  });

  it('describes pause draining, removal authority and replacement through the device flow', async () => {
    const writes = mount('admin');
    const choose = async (name: string) => {
      fireEvent.keyDown(await screen.findByRole('button', { name: 'More actions for homelab-mini' }), { key: 'Enter' });
      fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name }));
    };
    await choose('Pause');
    expect((await screen.findByRole('dialog')).textContent).toContain('Its assigned run can finish');
    fireEvent.click(screen.getByRole('button', { name: 'Pause runner' }));
    await waitFor(() => expect(writes).toContain('POST /api/runners/rn_mini/pause'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await choose('Remove');
    expect((await screen.findByRole('dialog')).textContent).toContain('does not terminate it');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await choose('Replace registration');
    expect((await screen.findByRole('dialog')).textContent).toContain('same runner ID');
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'BCDF-GHJK' } });
    expect((screen.getByRole('button', { name: 'Approve replacement' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check machine' }));
    await screen.findByText('Machine: Mini in the office');
    fireEvent.click(screen.getByRole('button', { name: 'Approve replacement' }));
    await waitFor(() => expect(writes).toContain('POST /api/runners/rn_mini/recredential'));
  });

  it('refuses a replacement preview for a different runner name or target', async () => {
    for (const options of [{ previewName: 'another-mini' }, { previewRunnerId: 'rn_other' }]) {
      const writes = mount('admin', RUNNER, options);
      fireEvent.keyDown(await screen.findByRole('button', { name: 'More actions for homelab-mini' }), { key: 'Enter' });
      fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Replace registration' }));
      fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'BCDF-GHJK' } });
      fireEvent.click(screen.getByRole('button', { name: 'Check machine' }));
      await screen.findByText(/This request does not match homelab-mini/);
      expect((screen.getByRole('button', { name: 'Approve replacement' }) as HTMLButtonElement).disabled).toBe(true);
      expect(writes).toEqual([]);
      cleanup(); clients.splice(0).forEach(client => client.clear());
    }
  });

  it('shows a failed read as unavailable without inventing an empty fleet or queue', async () => {
    mount('member', RUNNER, { fail: true });
    const failure = await screen.findByText(/Machine and queue information is unavailable/);
    expect(failure.textContent).toContain('Last check failed');
    expect(failure.textContent).toContain('Last successful read unavailable.');
    expect(screen.queryByText(/No runners are registered/)).toBeNull();
    expect(screen.queryByText(/No legacy workers are remembered/)).toBeNull();
    expect(screen.queryByText(/0 runs waiting/)).toBeNull();
  });

  it('forgets an offline legacy contact from either page while explaining preserved membership and capture', async () => {
    const legacy: WorkerRow = { credentialId: 'legacy_1', machineId: 'retired-laptop', runner: null, lastSeenAt: NOW - 1800000, recent: false, eligible: true, busy: null, offers: [], capabilities: [], lastReason: 'no_work' };
    for (const route of ['/runners', '/status/health']) {
      const writes = mount('admin', RUNNER, { legacy: [legacy], route });
      fireEvent.click(await screen.findByRole('button', { name: 'Forget this worker' }));
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain('never revokes the member credential');
      expect(dialog.textContent).toContain('membership or capture');
      expect(dialog.textContent).toContain('it reappears');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Forget worker' }));
      await waitFor(() => expect(writes).toContain('POST /api/workers/legacy/legacy_1/forget'));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Forget this worker' })).toBeNull());
      cleanup(); clients.splice(0).forEach(client => client.clear());
    }
  });

  it('uses the shared distinct queue reasons and preserves the oldest waiting age', async () => {
    for (const reason of ['capacity', 'no_runner', 'model_profile', 'settling', 'dispatch_ceiling', 'unavailable'] as const) {
      mount('member', RUNNER, { queue: { observedAt: NOW, count: 3, oldestAt: NOW - 18 * 60000, reasons: [{ reason, count: 3 }], nativeNeedsRunner: true } });
      await screen.findByText(QUEUE_REASON_WORDS[reason]);
      expect(screen.getByText(/3 runs waiting; oldest/).textContent).toContain('18m ago');
      expect(screen.getByText(/3 runs waiting; oldest/).closest('[data-queue-warning]')?.getAttribute('data-tone')).toBe('warn');
      expect(screen.getByText(/This native server no longer runs agent work by itself/)).toBeTruthy();
      cleanup(); clients.splice(0).forEach(client => client.clear());
    }
  });

  it('escalates an older blocked queue and uses scoped legacy empty wording for members', async () => {
    mount('member', RUNNER, { queue: { observedAt: NOW, count: 1, oldestAt: NOW - 70 * 60000, reasons: [{ reason: 'no_runner', count: 1 }], nativeNeedsRunner: false } });
    await screen.findByText('None of your machines run a legacy worker.');
    expect(screen.getByText(/1 run waiting; oldest/).closest('[data-queue-warning]')?.getAttribute('data-tone')).toBe('urgent');
  });

});
