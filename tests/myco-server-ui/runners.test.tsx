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
const RUNNER: RunnerRow = { id: 'rn_mini', name: 'homelab-mini', machineId: null, state: 'enabled', connected: true, version: '2.0.0-alpha.2', channel: 'alpha', latestVersion: '2.0.0-alpha.3', updateAvailable: true, lastSeenAt: NOW, lastCheckAt: NOW, offersObservedAt: NOW,
  display: 'Online', revision: 1, createdAt: NOW, createdBy: 'mem_1', removedAt: null, os: 'macOS', arch: 'arm64', readiness: { state: 'ready', reason: 'Reports a signed-in agent; provider access is untested.', observedAt: NOW }, offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], labels: [], preference: null, models: [], lastReason: 'no_work', lastAttempted: null, lastCompleted: null, lastFailed: null,
  lastResult: { fromVersion: '2.0.0-alpha.1', toVersion: '2.0.0-alpha.2', result: 'updated', at: NOW }, blockedVersion: null, updateState: null, updateRequest: null, busy: null };

function mount(role: 'admin' | 'member', initial: RunnerRow = RUNNER,
  options: { rows?: RunnerRow[]; legacy?: WorkerRow[]; fail?: boolean; route?: string; queue?: FleetQueue; previewName?: string; previewRunnerId?: string; storedCredentials?: Record<string, boolean>; runs?: (cursor: string | null) => unknown } = {}) {
  let runner = initial;
  const writes: string[] = [];
  let legacy = options.legacy ?? [];
  globalThis.fetch = (async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    const path = url.pathname;
    if (path === '/api/runners/rn_mini/runs' && options.runs !== undefined) return Response.json(options.runs(url.searchParams.get('cursor')));
    if (path === '/auth/me') return Response.json(dashboardMe({ sub: '1', login: 'owner', member: { id: 'mem_1', label: 'Chris', role } }));
    if (path === '/api/machines') return Response.json({ machines: [] });
    if (path === '/api/members') return Response.json({ members: [] });
    if (path === '/api/projects') return Response.json({ projects: [] });
    if (path === '/api/status') return Response.json({ schema: { expected: 80, found: 80, matches: true }, capabilities: [], projects: [], workers: { available: true, fleet: legacy, runsQueued: 0, workersBusy: 0 } });
    if (path === '/api/runners/agents') return Response.json({ agents: [{ agent: 'claude-code', storedUsable: false, runners: [{ id: 'rn_mini', name: 'homelab-mini', choice: runner.credentialChoices?.['claude-code'] ?? 'own' }] }], today: [{ id: 'rn_mini', name: 'homelab-mini', agent: 'claude-code' }] });
    if (path.startsWith('/api/machines/')) return Response.json({ machine: null, contactFacts: 'ready' });
    if (path === '/api/runs/hours') return Response.json({ counted: true, window: { name: 'day', since: NOW - 23 * 3_600_000, until: NOW, sliceMs: 3_600_000 }, lanes: [{ runnerId: 'rn_mini', name: 'homelab-mini', hours: [{ hour: NOW, worked: 3, unchanged: 2, failed: 1 }], checkins: [] }] });
    if (path === '/api/runners/removed') return Response.json({ runners: [], cursor: null });
    if (path === '/api/runners') return options.fail ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ observedAt: NOW, storedCredentials: options.storedCredentials ?? {}, runners: options.rows ?? [runner], legacyWorkers: legacy, queue: options.queue ?? { observedAt: NOW, count: 0, oldestAt: null, reasons: [], nativeNeedsRunner: false } });
    if (path === '/api/device/preview') return Response.json({ subject: 'runner', runnerName: options.previewName ?? 'homelab-mini', replacingRunnerId: options.previewRunnerId ?? 'rn_mini', machineName: 'Mini in the office', os: 'macOS', ip: '192.0.2.1', approverIp: '192.0.2.2', ageSeconds: 12, scope: 'runner', expiresAt: NOW + 60000 });
    if (path === '/api/runners/rn_mini/update') {
      writes.push(`${init?.method} ${path}`);
      runner = { ...runner, updateRequest: { id: 'request_1', requestedAt: NOW, clearBlock: true } };
      return Response.json({ requested: true, updateRequest: runner.updateRequest });
    }
    if (path === '/api/runners/rn_mini/sign-in') {
      const body = JSON.parse(String(init?.body));
      writes.push(`${init?.method} ${path} ${JSON.stringify(body)}`);
      runner = { ...runner, credentialChoices: { ...runner.credentialChoices, [body.agent]: body.choice } };
      return Response.json({ credentialChoices: runner.credentialChoices });
    }
    if (init?.method === 'POST' && /^\/api\/runners\/rn_[^/]+\/[a-z-]+$/.test(path)) { writes.push(`${init.method} ${path}`); return Response.json({ changed: true }); }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[options.route ?? '/runners']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return writes;
}

const MACHINE = '/settings/people/runners/rn_mini';
const card = (name: string) => screen.getByText(name).closest('li')!;
/** The verdict a machine page leads with, once drawn. */
const verdictOf = (label: string) => waitFor(() => { const element = document.querySelector<HTMLElement>(`[data-machine-verdict="${label}"]`); expect(element).not.toBeNull(); return element!; });

describe('Runners page', () => {
  it('lists one row per runner with how it stands, what it is doing or last did, and its machine page, and no controls', async () => {
    const lease = { projectId: 'proj_1', projectName: 'Myco', task: 'title-summary', at: NOW, status: 'running', runId: 'run_1', leaseExpiresAt: NOW + 60000 };
    const rows: RunnerRow[] = [
      { ...RUNNER, id: 'busy', name: 'Busy machine', display: 'Busy', busy: lease },
      { ...RUNNER, id: 'hold', name: 'Hold machine', display: 'Not ready', readiness: { state: 'unknown', code: 'incompatible', reason: 'detail', observedAt: NOW } },
      { ...RUNNER, id: 'paused', name: 'Paused machine', display: 'Paused', state: 'paused' },
      { ...RUNNER, id: 'stale', name: 'Stale machine', display: 'Offline', connected: false, lastSeenAt: NOW - 1800000 },
      { ...RUNNER, id: 'on_mac', name: 'Joined machine', machineId: 'mac_1' },
    ];
    const writes = mount('admin', RUNNER, { rows });
    await screen.findByText('Busy machine');
    expect(card('Busy machine').textContent).toContain('Writing a title for Myco');
    expect(card('Hold machine').textContent).toContain('Its agent needs an update');
    expect(card('Paused machine').textContent).toContain('Paused; it takes no new work');
    expect(card('Stale machine').textContent).toContain('last seen 30 min ago');
    expect(within(card('Busy machine')).getByRole('link', { name: 'Its machine' }).getAttribute('href')).toBe('/settings/people/runners/busy');
    expect(within(card('Joined machine')).getByRole('link', { name: 'Its machine' }).getAttribute('href')).toBe('/settings/people/machines/mac_1#runner-on_mac');
    for (const name of ['Update now', 'Use this machine’s sign-in', 'More actions for Busy machine']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('a runner’s machine page', () => {
  it('leads with Working only while it holds a run, then its learning agent and payer, its recent runs and the release it reported, and updates it between runs', async () => {
    const writes = mount('admin', { ...RUNNER, busy: { projectId: 'proj_1', projectName: 'Myco', task: 'title-summary', at: NOW, status: 'running', runId: 'run_1', leaseExpiresAt: NOW + 60000 } }, { route: MACHINE });
    expect((await verdictOf('Working')).textContent).toContain('Writing a title for Myco');
    expect(screen.getByText(/It reported macOS, arm64, version 2.0.0-alpha.2/)).toBeTruthy();
    expect(await screen.findByText('For learning from sessions: Claude Code, paid by its own sign-in')).toBeTruthy();
    expect(screen.getByText(/other work may use another agent\. It is the only runner with Claude Code\./)).toBeTruthy();
    expect(await screen.findByText(/^Since .+: 6 runs, 3 worked, 2 changed nothing, 1 failed\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See its runs' }).getAttribute('href')).toBe('/work/history?runner=rn_mini');
    expect(screen.getByText(/A newer release, 2.0.0-alpha.3, is out\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update homelab-mini now' }));
    await waitFor(() => expect(writes).toEqual(['POST /api/runners/rn_mini/update']));
  });

  it('says Online for a runner waiting for work, never Working', async () => {
    mount('admin', RUNNER, { route: MACHINE });
    expect((await verdictOf('Online')).textContent).toContain('Waiting for work.');
    expect(document.querySelector('[data-machine-verdict="Working"]')).toBeNull();
  });

  it('shows a member the runner without any control', async () => {
    const writes = mount('member', RUNNER, { route: MACHINE });
    await verdictOf('Online');
    expect((screen.getByRole('switch', { name: 'homelab-mini runs Myco’s work' }) as HTMLButtonElement).disabled).toBe(true);
    for (const name of ['Update homelab-mini now', 'Set homelab-mini apart', 'Remove homelab-mini…', 'More for homelab-mini']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByText('Which agent it would use and who pays are shown to an admin.')).toBeTruthy();
    expect(writes).toEqual([]);
  });

  it('says an offline runner could use its agent by the sign-ins it last reported, and holds the update', async () => {
    mount('admin', { ...RUNNER, connected: false, display: 'Offline', lastSeenAt: NOW - 3 * 3_600_000, offersObservedAt: NOW - 3 * 3_600_000 }, { route: MACHINE });
    expect((await verdictOf('Offline')).textContent).toContain('last seen 3 h ago');
    expect(await screen.findByText(/It could use it, by the sign-ins it reported 3 h ago\./)).toBeTruthy();
    expect(screen.queryByText(/can use it now/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Update homelab-mini now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a held release with its end, its update phase since when, and a missing channel', async () => {
    mount('admin', { ...RUNNER, channel: null, lastCheckAt: NOW - 3_600_000, blockedVersion: { version: '2.0.0-alpha.3', until: NOW - 60_000, reason: 'Launch failed' }, updateState: { phase: 'cleanup_pending', since: NOW - 120_000, reason: 'Guardian cleanup failed' } }, { route: MACHINE });
    const release = await screen.findByText('homelab-mini is on 2.0.0-alpha.2');
    const row = release.closest('[data-setting]')!;
    expect(row.textContent).toContain('It reported no release channel, so it can’t be updated from here.');
    expect(row.textContent).toContain('It last checked for an update 1 h ago.');
    expect(row.textContent).toMatch(/Finishing update cleanup since .+: Guardian cleanup failed\./);
    expect(row.textContent).toMatch(/Release 2.0.0-alpha.3 was held back until .+; that hold has ended: Launch failed\./);
  });

  it('turns the runner off, removes it on its own, and replaces its registration through the device flow', async () => {
    const writes = mount('admin', RUNNER, { route: MACHINE });
    fireEvent.click(await screen.findByRole('switch', { name: 'homelab-mini runs Myco’s work' }));
    await waitFor(() => expect(writes).toContain('POST /api/runners/rn_mini/pause'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove homelab-mini…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove homelab-mini as a runner?' });
    expect(dialog.textContent).toContain('the process on the machine isn’t ended');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove homelab-mini' }));
    await waitFor(() => expect(writes).toContain('POST /api/runners/rn_mini/remove'));
    expect(writes.filter((write) => write.includes('/api/machines/'))).toEqual([]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'More for homelab-mini' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Replace its registration' }));
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'BCDF-GHJK' } });
    expect((screen.getByRole('button', { name: 'Approve replacement' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Check machine' }));
    await screen.findByText('Machine: Mini in the office');
    fireEvent.click(screen.getByRole('button', { name: 'Approve replacement' }));
    await waitFor(() => expect(writes).toContain('POST /api/runners/rn_mini/recredential'));
  });

  it('refuses a replacement preview for a different runner', async () => {
    const writes = mount('admin', RUNNER, { route: MACHINE, previewRunnerId: 'rn_other' });
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for homelab-mini' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Replace its registration' }));
    fireEvent.change(screen.getByLabelText('Device code'), { target: { value: 'BCDF-GHJK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check machine' }));
    await screen.findByText(/This request does not match homelab-mini/);
    expect((screen.getByRole('button', { name: 'Approve replacement' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes).toEqual([]);
  });

  it('lists each runner registration on one machine with its own controls and links, whichever checked in last', async () => {
    const older = { ...RUNNER, machineId: 'mac_1', lastSeenAt: NOW - 60_000 };
    const newer = { ...RUNNER, id: 'rn_mini2', name: 'mini-two', machineId: 'mac_1', lastSeenAt: NOW };
    const writes = mount('admin', RUNNER, { route: '/settings/people/machines/mac_1', rows: [older, newer] });
    const first = await waitFor(() => { const card = document.querySelector<HTMLElement>('[data-runner-card="rn_mini"]'); expect(card).not.toBeNull(); return card!; });
    const second = document.querySelector<HTMLElement>('[data-runner-card="rn_mini2"]')!;
    expect(first.id).toBe('runner-rn_mini');
    expect(within(first).getByRole('link', { name: 'homelab-mini’s check-ins' }).getAttribute('href')).toBe('/work/runners/rn_mini');
    expect(within(second).getByRole('link', { name: 'mini-two’s check-ins' }).getAttribute('href')).toBe('/work/runners/rn_mini2');
    fireEvent.click(within(first).getByRole('button', { name: 'Remove homelab-mini…' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Remove homelab-mini as a runner?' })).getByRole('button', { name: 'Remove homelab-mini' }));
    await waitFor(() => expect(writes).toEqual(['POST /api/runners/rn_mini/remove']));
  });

  it('leads an old runner anchor to that runner’s card on its machine', async () => {
    mount('admin', RUNNER, { route: '/runners#runner-rn_mini2', rows: [RUNNER, { ...RUNNER, id: 'rn_mini2', name: 'mini-two', machineId: 'mac_1' }] });
    await waitFor(() => expect(document.querySelector('[data-runner-card="rn_mini2"]')).not.toBeNull());
    expect(screen.getByRole('heading', { level: 1, name: 'mini-two' })).toBeTruthy();
  });

  it('shows the legacy worker on a machine with no registered runner, its work, and the way to a runner', async () => {
    const legacy: WorkerRow = { credentialId: 'mt_legacy', machineId: 'mac_legacy', offers: [{ id: 'codex', authenticated: true }], capabilities: [], lastReason: null, lastSeenAt: NOW, eligible: true, recent: true,
      busy: { runId: 'run_9', projectId: 'proj_1', task: 'title-summary', leaseExpiresAt: NOW + 60_000 } };
    mount('admin', RUNNER, { route: '/settings/people/machines/mac_legacy', rows: [], legacy: [legacy] });
    expect((await verdictOf('Working')).textContent).toContain('as a legacy worker');
    const card = document.querySelector('[data-legacy-on-machine]')!;
    expect(card.textContent).toContain('It runs Myco’s work as a legacy worker, with no registered runner');
    expect(card.textContent).toContain(`myco runner register ${window.location.origin}`);
    expect(screen.queryByText('No')).toBeNull();
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

  it('uses the shared distinct queue reasons and preserves the oldest waiting age', async () => {
    for (const reason of ['capacity', 'no_runner', 'model_profile', 'credential_unavailable', 'settling', 'dispatch_ceiling', 'unavailable'] as const) {
      mount('admin', RUNNER, { queue: { observedAt: NOW, count: 3, oldestAt: NOW - 18 * 60000, reasons: [{ reason, count: 3 }], nativeNeedsRunner: true } });
      await screen.findByText(QUEUE_REASON_WORDS[reason]);
      expect(screen.getByText(/3 runs waiting; oldest/).textContent).toContain('18 min ago');
      expect(screen.getByText(/3 runs waiting; oldest/).closest('[data-queue-warning]')?.getAttribute('data-tone')).toBe('warn');
      expect(screen.getByText(/This native server no longer runs agent work by itself/)).toBeTruthy();
      cleanup(); clients.splice(0).forEach(client => client.clear());
    }
  });

  it('shows a waiting message without a count while queue heads build', async () => {
    mount('admin', RUNNER, { queue: { state: 'building', observedAt: NOW, count: null, oldestAt: null,
      reasons: [{ reason: 'queue_building', count: null }], nativeNeedsRunner: false } });
    await screen.findByText(QUEUE_REASON_WORDS.queue_building);
    expect(screen.queryByText(/runs waiting; oldest/)).toBeNull();
  });

  it('escalates an older blocked queue and uses scoped legacy empty wording for members', async () => {
    mount('member', RUNNER, { queue: { observedAt: NOW, count: 1, oldestAt: NOW - 70 * 60000, reasons: [{ reason: 'no_runner', count: 1 }], nativeNeedsRunner: false } });
    await screen.findByText('None of your machines run a legacy worker.');
    expect(screen.getByText(/1 run waiting; oldest/).closest('[data-queue-warning]')?.getAttribute('data-tone')).toBe('urgent');
  });

});

describe('setting one machine apart', () => {
  const apart = async () => { fireEvent.click(await screen.findByRole('button', { name: 'Set homelab-mini apart' })); return screen.findByRole('dialog'); };

  it('saves who pays for one agent on this runner alone, with the stored key offered only when one is usable', async () => {
    const writes = mount('admin', RUNNER, { route: MACHINE, storedCredentials: { 'claude-code': true } });
    const dialog = await apart();
    expect(within(dialog).getByText('Claude Code · Paid by its own sign-in')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use the server’s stored key' }));
    await within(dialog).findByText('Claude Code · Paid by the stored key');
    expect(writes).toEqual(['POST /api/runners/rn_mini/sign-in {"agent":"claude-code","choice":"stored"}']);
  });

  it('disables the stored key without a usable one, and asks again for a choice this server can no longer use', async () => {
    mount('admin', { ...RUNNER, credentialChoices: { 'claude-code': null } }, { route: MACHINE });
    const dialog = await apart();
    expect(within(dialog).getByText('Claude Code · Choose who pays for this agent')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Use the server’s stored key' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('No stored key this agent can use.')).toBeTruthy();
  });
});

it('shows a failed agent sign-in and a stored-key failure for another agent on the machine page while the runner stays online', async () => {
  mount('admin', { ...RUNNER, storedKeyFailures: [{ agent: 'cursor', slot: 'cursor', failure: 'invalid_key' }], offers: [
    { id: 'claude-code', authenticated: false, unavailableReason: 'login_missing',
      signInFailure: { name: 'Claude Code', source: 'own', hint: 'Open a GUI Terminal on this Mac, run claude, then /login.' } },
    { id: 'codex', authenticated: true },
  ] }, { route: MACHINE });
  const failure = await screen.findByText('Claude Code could not sign in at launch. Open a GUI Terminal on this Mac, run claude, then /login.');
  expect(await screen.findByText(/^Cursor · The Cursor key was rejected\./)).toBeTruthy();
  expect(failure.closest('details')).toBeNull();
  await verdictOf('Online');
});

describe('Runner page', () => {
  const ran = (runId: string, outcome: string, minutesAgo: number, drift: Record<string, unknown> = {}) => ({ attemptId: `att_${runId}`, claimedAt: NOW - minutesAgo * 60_000, projectId: 'proj_1', projectName: 'Myco', runId, task: 'canopy-map', completedAt: null, outcome,
    runnerVersion: null, agentVersion: null, harness: 'claude-code', requested: null, identity: { status: 'not_recorded' }, ...drift });
  const facts = { id: 'rn_mini', name: 'homelab-mini', state: 'enabled', lastSeenAt: NOW - 5_000, version: '2.0.0-alpha.2' };

  it('opens from its machine page: its last check-in, how its recent runs went, and each run linked, older runs on request', async () => {
    mount('member', RUNNER, { route: MACHINE, runs: (cursor) => cursor === null
      ? { runner: facts, rows: [ran('run_new', 'running', 1), ran('run_ok', 'worked', 20), ran('run_bad', 'failed', 40)], cursor: 'next' }
      : { runner: facts, rows: [ran('run_old', 'changed_nothing', 90)], cursor: null } });
    fireEvent.click(await screen.findByRole('link', { name: 'homelab-mini’s check-ins' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'homelab-mini' })).toBeTruthy();
    expect(screen.getByText(/Last checked in just now/)).toBeTruthy();
    expect(screen.getByText(/1 of the last 2 finished runs worked/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Failed/ }).getAttribute('href')).toBe('/p/proj_1/work/runs/run_bad');
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() => expect(screen.getByText(/2 of the last 3 finished runs worked/)).toBeTruthy());
    expect(screen.getByRole('link', { name: /Worked; changed nothing/ }).getAttribute('href')).toBe('/p/proj_1/work/runs/run_old');
  });

  it('counts the versions its shown runs ran with', async () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, at) => ran(`run_new${at}`, 'worked', at + 1, { runnerVersion: '2.0.0-alpha.24', agentVersion: '2.1.3' })),
      ran('run_handed', 'handed_on', 12, { runnerVersion: '2.0.0-alpha.23', agentVersion: '2.1.2' }),
      ran('run_old', 'failed', 30),
    ];
    mount('member', RUNNER, { route: '/runners/rn_mini', runs: () => ({ runner: facts, rows, cursor: null }) });
    const drift = await screen.findByRole('region', { name: 'What its runs ran with' });
    const said = (kind: string) => drift.querySelector(`[data-drift="${kind}"]`)!.textContent!;
    expect(said('runner')).toContain('Ran 2.0.0-alpha.24 for 5 runs, 2.0.0-alpha.23 for 1 run, not reported for 1 run');
    expect(said('runner')).toContain('Runner reports');
    expect(said('agent')).toContain('Claude Code 2.1.3 for 5 runs, 2.1.2 for 1 run, not reported for 1 run');
  });

  it('counts only a reported model that matches as the model it was asked for, and keeps each comparison state its own line', async () => {
    const profile = (model: string, resolvesTo?: string) => ({ tier: 'default', model, effort: null, sources: { tier: 'task', model: 'configured' }, ...(resolvesTo === undefined ? {} : { resolvesTo }) });
    const recorded = (model: string, status = 'reported', provider?: string) => ({ status, source: 'stream', primary: { model, ...(provider === undefined ? {} : { provider }) }, models: [{ model }] });
    const sonnet = profile('sonnet', 'claude-sonnet-5-5');
    const rows = [
      ...Array.from({ length: 2 }, (_, at) => ran(`run_ok${at}`, 'worked', at + 1, { requested: sonnet, identity: recorded('claude-sonnet-5-5') })),
      ran('run_haiku', 'worked', 5, { requested: sonnet, identity: recorded('claude-haiku-5-5') }),
      ran('run_handed', 'handed_on', 6, { requested: sonnet, identity: recorded('claude-haiku-5-5') }),
      ran('run_alias', 'worked', 7, { harness: 'opencode', requested: profile('openrouter/~anthropic/claude-opus-latest'), identity: recorded('anthropic/claude-opus-5', 'reported', 'openrouter') }),
      ran('run_launch', 'worked', 8, { harness: 'codex', requested: profile('gpt-5.5'), identity: recorded('gpt-5.5', 'launched') }),
      // The same model asked and run, compared against a recorded resolution and without one, in both orders.
      ran('run_bare1', 'worked', 9, { harness: 'codex', requested: profile('gpt-5.5'), identity: recorded('gpt-5.5-2026') }),
      ran('run_resolved', 'worked', 10, { harness: 'codex', requested: profile('gpt-5.5', 'gpt-5.5-2026'), identity: recorded('gpt-5.5-2026') }),
      ran('run_bare2', 'worked', 11, { harness: 'codex', requested: profile('gpt-5.5'), identity: recorded('gpt-5.5-2026') }),
    ];
    mount('member', RUNNER, { route: '/runners/rn_mini', runs: () => ({ runner: facts, rows, cursor: null }) });
    const drift = await screen.findByRole('region', { name: 'What its runs ran with' });
    expect(drift.querySelector('[data-drift="models"]')!.textContent).toContain(
      'Ran the model it was asked for in 3 of 7 runs whose agent reported its model; 1 run can’t be confirmed; 1 run recorded only the model it was launched with');
    const lines = [...drift.querySelectorAll<HTMLElement>('[data-model-drift]')].map((line) => [line.textContent, line.dataset.modelDrift]);
    expect(lines).toEqual([
      ['Claude Code: Asked for Sonnet (resolves to claude-sonnet-5-5), ran claude-sonnet-5-5: 2 runs', 'match'],
      ['Codex: Asked for gpt-5.5, ran gpt-5.5-2026, a different model than asked: 2 runs', 'mismatch'],
      ['Claude Code: Asked for Sonnet (resolves to claude-sonnet-5-5), ran claude-haiku-5-5, a different model than asked: 1 run', 'mismatch'],
      ['OpenCode: Asked for openrouter/~anthropic/claude-opus-latest, ran openrouter/anthropic/claude-opus-5; the provider chooses which model this name runs, so it can’t be confirmed: 1 run', 'unconfirmed'],
      ['Codex: Asked for gpt-5.5, launched with gpt-5.5; the agent did not report what it ran: 1 run', 'launched'],
      ['Codex: Asked for gpt-5.5 (resolves to gpt-5.5-2026), ran gpt-5.5-2026: 1 run', 'match'],
    ]);
  });
});
