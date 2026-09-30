/**
 * People & machines and My machines: machines built from credentials and
 * named without ids, Myco's own account kept out of the people and named
 * "Myco", and each member's own machines on My machines, with no admin route
 * asked for a member.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { matchRoute } from '@myco-server-worker/routes.js';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { machinesFrom } from '../../packages/myco-server/ui/src/features/admin/machines';
import type { CredentialRow } from '../../packages/myco-server/ui/src/features/admin/wire';
import { rawIdsIn } from '../helpers/raw-ids';

(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;

const ADA = 'mem_q3Vb8xRk2LmT7wYz';
const LIN = 'mem_Hn5-pC0dJfA9sE_u';
const ROE = 'mem_Zk2vW9qLp4Ty7NbR';
const PROJECT = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const SESSION = '2f1c9a4e-7b3d-4c8a-9e61-0d5f3a2b7c19';
const NOW_MS = Date.now();
const DAY = 86_400_000;

const member = (id: string, label: string, over: Record<string, unknown> = {}) => ({
  id, label, role: 'member', linked: true, createdAt: NOW_MS - 30 * DAY, revokedAt: null, revokedBy: null, liveCredentials: 1, ...over,
});
const MEMBERS = { members: [
  member(ADA, 'Ada', { role: 'admin' }),
  // Joined without naming themselves: the label is the id, as join records it.
  member(LIN, LIN),
  member('mem_harness', 'harness', { role: 'admin' }),
  member(ROE, 'Roe', { revokedAt: NOW_MS - 2 * DAY, revokedBy: 'mem_harness' }),
] };

const credential = (over: Partial<CredentialRow> = {}): CredentialRow => ({
  id: 'mt_Xr4pQ9sLw2Ze8KbN', memberId: ADA, machineId: 'ada_5a2d54af', runtimeLabel: 'Ada’s MacBook', expiresAt: NOW_MS + DAY, revokedAt: null, revokedBy: null,
  bytesWritten: 2_097_152, lineageRoot: 'mt_Xr4pQ9sLw2Ze8KbN', lineageStartedAt: NOW_MS - DAY, firstUsedAt: null, live: true, purpose: 'member', ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit, url?: URL) => Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return routes[url.pathname]?.(init, url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return asked;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const me = (id: string, label: string, role: 'admin' | 'member') => ({ sub: '1', login: 'someone', member: { id, label, role } });

function deployment(viewer: ReturnType<typeof me>, credentials: CredentialRow[], extra: Record<string, (init?: RequestInit, url?: URL) => Response> = {}) {
  return server({
    '/auth/me': () => Response.json(viewer),
    '/api/projects': () => Response.json({ projects: [{ projectId: PROJECT, name: 'Myco', createdAt: 0, sessionCount: 1, lastActivityAt: NOW_MS, archivedAt: null, archivedBy: null }] }),
    '/api/members': () => Response.json(MEMBERS),
    '/api/enrollment': () => Response.json({ invitations: [{ id: 'en_Pq8sT3vW', memberId: LIN, createdBy: 'mem_harness', createdAt: NOW_MS, expiresAt: NOW_MS + 3_600_000, role: 'member', projectId: null }] }),
    '/api/status': () => Response.json({ schema: { expected: 1, found: 1, matches: true }, target: 'bun', capabilities: [], projects: [], workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] } }),
    '/api/credentials': (_init, url) => Response.json({ rows: url?.searchParams.get('purpose') === 'run' ? [] : credentials.filter((c) => viewer.member.role === 'admin' || c.memberId === viewer.member.id), cursor: null }),
    ...extra,
  });
}

/** The requests among `asked` that reach a route only an admin is admitted to. */
const adminRequests = (asked: readonly string[]): string[] => asked.filter((line) => {
  const [method, pathname] = line.split(' ') as [string, string];
  const matched = matchRoute(method, pathname);
  return matched !== null && matched.route.auth === 'session' && matched.route.authority === 'admin';
});

describe('machinesFrom', () => {
  it('groups a member\'s runtimes by machine, names each by its newest live runtime, and leaves runs out', () => {
    const machines = machinesFrom([
      credential({ id: 'mt_new', lineageRoot: 'mt_new', runtimeLabel: 'Studio (renamed)', lineageStartedAt: NOW_MS - DAY }),
      credential({ id: 'mt_old', lineageRoot: 'mt_old', runtimeLabel: 'Studio', lineageStartedAt: NOW_MS - 5 * DAY, live: false, revokedAt: NOW_MS - 2 * DAY, revokedBy: ADA }),
      credential({ id: 'mt_run', lineageRoot: 'mt_run', purpose: 'run', machineId: 'harness', runtimeLabel: null }),
    ]);
    expect(machines).toHaveLength(1);
    expect(machines[0]).toMatchObject({ name: 'Studio (renamed)', named: true, standing: 'allowed', firstSeenAt: NOW_MS - 5 * DAY });
    expect(machines[0]!.live.map((c) => c.id)).toEqual(['mt_new']);
    expect(machines[0]!.credentials.map((c) => c.id)).toEqual(['mt_new', 'mt_old']);
  });

  it('names the only machine without a name "A machine", and several by their place', () => {
    expect(machinesFrom([credential({ runtimeLabel: null })]).map((m) => [m.name, m.named])).toEqual([['A machine', false]]);
    const machines = machinesFrom([
      credential({ id: 'mt_a', lineageRoot: 'mt_a', machineId: 'm_a', runtimeLabel: '  ', lineageStartedAt: NOW_MS - DAY }),
      credential({ id: 'mt_b', lineageRoot: 'mt_b', machineId: 'm_b', runtimeLabel: 'Desk', lineageStartedAt: NOW_MS - 2 * DAY }),
      credential({ id: 'mt_c', lineageRoot: 'mt_c', machineId: null, runtimeLabel: null, lineageStartedAt: NOW_MS - 3 * DAY }),
    ]);
    expect(machines.map((m) => m.name)).toEqual(['Machine 1', 'Desk', 'Machine 2']);
  });

  it('lists machines allowed to write first, newest first, and says where each stopped one stands', () => {
    const machines = machinesFrom([
      credential({ id: 'mt_1', lineageRoot: 'mt_1', machineId: 'm_1', runtimeLabel: 'Replayed', lineageStartedAt: NOW_MS, live: false, revokedAt: NOW_MS, revokedBy: 'lineage-replay' }),
      credential({ id: 'mt_2', lineageRoot: 'mt_2', machineId: 'm_2', runtimeLabel: 'Old', lineageStartedAt: NOW_MS - 9 * DAY }),
      credential({ id: 'mt_3', lineageRoot: 'mt_3', machineId: 'm_3', runtimeLabel: 'Ran out', lineageStartedAt: NOW_MS - DAY, live: false }),
      credential({ id: 'mt_4', lineageRoot: 'mt_4', machineId: 'm_4', runtimeLabel: 'Stopped', lineageStartedAt: NOW_MS - 2 * DAY, live: false, revokedAt: NOW_MS, revokedBy: LIN }),
    ]);
    expect(machines.map((m) => [m.name, m.standing, m.stoppedBy])).toEqual([
      ['Old', 'allowed', null], ['Replayed', 'replayed', null], ['Ran out', 'expired', null], ['Stopped', 'stopped', LIN],
    ]);
  });
});

describe('People & machines', () => {
  it('leaves Myco\'s own account out of the people, names it "Myco", and shows no raw id anywhere', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [
      credential(),
      credential({ id: 'mt_Lq2wE4rT6yU8iO0p', lineageRoot: 'mt_Lq2wE4rT6yU8iO0p', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: null }),
    ]);
    mount('/people');
    const people = await screen.findByRole('list', { name: 'Members' });
    expect(within(people).getAllByRole('listitem').map((li) => li.querySelector('.font-medium')?.textContent)).toEqual(['Ada', 'Unnamed member']);
    expect(people.textContent).not.toMatch(/harness|Myco/);
    // Myco's account appears only by its name: who made an invitation, and who removed a member.
    expect(await screen.findByText(/^by Myco · expires in (59|60)m$/)).toBeTruthy();
    expect(screen.getByText('A machine for Unnamed member')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }));
    expect((await screen.findByRole('list', { name: 'Removed members' })).textContent).toMatch(/Roe.*Removed 2 days ago by Myco/);
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('A machine'));
    expect(machines.textContent).toContain('Unnamed member · allowed to write');
    expect(rawIdsIn(document.body)).toEqual([]);
  });

  it('adds a machine for a member from their menu, with that member picked', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [credential()]);
    mount('/people');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Unnamed member' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: `${INVITE_CONTROLS.button} for them` }));
    const dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.button });
    expect(within(dialog).getByRole('combobox', { name: INVITE_CONTROLS.field }).textContent).toContain('Unnamed member');
  });

  it('shows what a machine wrote: what, where and when, with its session linked and no id shown', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [credential()], {
      '/api/credentials/mt_Xr4pQ9sLw2Ze8KbN/activity': () => Response.json({ rows: [
        { eventId: 'ev_1', projectId: PROJECT, sessionId: SESSION, kind: 'prompt', createdAt: NOW_MS - 5 * 60_000, receivedAt: NOW_MS },
        { eventId: 'ev_2', projectId: 'proj_ffffffffffffffffffffffffffffffff', sessionId: SESSION, kind: 'mystery', createdAt: NOW_MS - 2 * 3_600_000, receivedAt: NOW_MS },
      ], cursor: null }),
    });
    mount('/people');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Ada’s MacBook' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'What it wrote' }));
    const dialog = await screen.findByRole('dialog', { name: 'What Ada’s MacBook wrote' });
    const rows = await within(dialog).findByRole('list', { name: 'What it wrote' });
    expect(within(rows).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'PromptMyco · 5 min agoOpen session', 'Something elseA project · 2 h agoOpen session',
    ]);
    expect(within(rows).getAllByRole('link', { name: 'Open session' })[0]!.getAttribute('href')).toBe(`/p/${PROJECT}/sessions/${SESSION}`);
    expect(dialog.textContent).toContain('2.0 MB in all');
    expect(rawIdsIn(dialog)).toEqual([]);
  });
});

describe('My machines', () => {
  const MINE = [
    credential({ id: 'mt_Lq2wE4rT6yU8iO0p', lineageRoot: 'mt_Lq2wE4rT6yU8iO0p', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: 'Lin’s build box' }),
    credential(),
  ];

  it('lists a member only their own machines, with their settings and Stop, and asks no admin route', async () => {
    const asked = deployment(me(LIN, LIN, 'member'), MINE);
    mount('/me/machines');
    expect(await screen.findByRole('heading', { level: 1, name: 'My machines' })).toBeTruthy();
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await waitFor(() => expect(within(machines).getAllByRole('listitem')).toHaveLength(1));
    expect(machines.textContent).toContain('Lin’s build box');
    expect(machines.textContent).toMatch(/^Lin’s build boxallowed to write · first signed in/);
    fireEvent.keyDown(within(machines).getByRole('button', { name: 'More for Lin’s build box' }), { key: 'Enter' });
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Its settings', 'What it wrote', 'Stop']);
    expect(screen.queryByRole('button', { name: INVITE_CONTROLS.button })).toBeNull();
    expect(screen.getByText(/an admin creates a one-time link on/).textContent).toContain(INVITE_CONTROLS.page);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adminRequests(asked)).toEqual([]);
    expect(rawIdsIn(document.body)).toEqual([]);
  });

  it('lists an admin only their own machines, and adds another for themselves', async () => {
    deployment(me(ADA, 'Ada', 'admin'), MINE);
    mount('/me/machines');
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('Ada’s MacBook'));
    expect(machines.textContent).not.toContain('Lin’s build box');
    expect(screen.queryByText(/an admin creates a one-time link/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: INVITE_CONTROLS.button }));
    const dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.button });
    expect(within(dialog).getByRole('combobox', { name: INVITE_CONTROLS.field }).textContent).toContain('You');
  });

  it('says so when none of the member\'s machines has signed in', async () => {
    deployment(me(LIN, LIN, 'member'), []);
    mount('/me/machines');
    expect(await screen.findByText('None of your machines has signed in yet.')).toBeTruthy();
  });
});
