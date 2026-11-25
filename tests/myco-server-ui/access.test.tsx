/**
 * Deployment access on Settings › People and machines and each machine's page: members, invitations, machines and
 * Myco's run credentials, as an admin administers them. Every destructive act
 * sits in a ⋯ menu behind a confirm that keeps the server's refusal in view.
 */
import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, describe, expect, it } from 'bun:test';
import { MACHINE_SETTINGS_CONTROLS } from '@goondocks/myco-shared/setup-guidance';
import { INVITE_CONTROLS, MEMBER_KEEPS_MACHINES, REJOIN_FOR_ADMIN, REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { formatUntil } from '../../packages/myco-server/ui/src/lib/format';
import { agoWords, dateTimeWords, dayWords } from '../../packages/myco-shared/src/time-words';
import type { CredentialRow } from '../../packages/myco-server/ui/src/features/admin/wire';
import { invitationExpiry, loginCommand } from '../../packages/myco-server/ui/src/features/admin/people/words';

it('copies a validated invitation as a literal argument accepted by cmd and POSIX shells', async () => {
  const { parseJoinCode } = await import('@myco/member/join-code.js');
  const key = 'k'.repeat(43);
  const command = loginCommand(key, 'https://myco.example');
  expect(command).toBe(`myco login https://myco.example/join#${key}`);
  expect(parseJoinCode(command.slice('myco login '.length))).toMatchObject({ serverUrl: 'https://myco.example', key });
  expect(loginCommand(key, 'http://[::1]:8787')).toBe(`myco login "http://[::1]:8787/join#${key}"`);
});
import { rawIdsIn } from '../helpers/raw-ids';
import { machineRows } from './machine-fixtures';

// jsdom lays nothing out, so it has no scrollIntoView; Radix's select calls it as it opens.
(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;

const ADA = 'mem_q3Vb8xRk2LmT7wYz';
const LIN = 'mem_Hn5-pC0dJfA9sE_u';
const ME = { sub: '583231', login: 'octocat', member: { id: ADA, label: 'Ada', role: 'admin' as const } };
const MEMBERS = { members: [
  { id: ADA, label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 2, liveMachines: 2 },
  { id: LIN, label: 'Lin', role: 'member', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0, liveMachines: 0 },
] };
const NOW_MS = Date.now();

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

/** One stubbed endpoint, handed the request and its URL so it can answer what the page asked for. */
type Endpoint = (init?: RequestInit, url?: URL) => Response;

function server(routes: Record<string, Endpoint>): { posts: { path: string; body: unknown }[] } {
  const posts: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return routes[url.pathname]?.(init, url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { posts };
}

function mount(path: string, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const credential = (over: Record<string, unknown> = {}) => ({
  id: 'mt_Xr4pQ9sLw2Ze8KbN', memberId: ADA, machineId: 'ada_5a2d54af', runtimeLabel: 'Ada’s MacBook', expiresAt: NOW_MS + 86_400_000, revokedAt: null, revokedBy: null,
  bytesWritten: 0, lineageRoot: 'mt_Xr4pQ9sLw2Ze8KbN', lineageStartedAt: NOW_MS - 86_400_000, firstUsedAt: null, live: true, purpose: 'member', ...over,
});
const FLEET_WORKER = {
  credentialId: 'mt_Xr4pQ9sLw2Ze8KbN', machineId: 'ada_5a2d54af', offers: [{ id: 'codex', authenticated: true }], capabilities: [],
  lastReason: 'no_work', lastSeenAt: NOW_MS - 3_000, busy: null, eligible: true, recent: true,
};
const status = (workers: Record<string, unknown> = {}) => ({
  schema: { expected: 44, found: 44, matches: true }, target: 'bun', capabilities: [], projects: [],
  workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [FLEET_WORKER], ...workers },
});

/** A Deployment whose credentials answer per purpose, as the route does. */
function accessServer(credentials: { member?: unknown[]; run?: unknown[] }, routes: Record<string, Endpoint> = {}) {
  const members = credentials.member ?? [];
  const machines = machineRows(members as CredentialRow[]);
  return server({
    '/auth/me': () => Response.json(dashboardMe(ME)),
    '/api/projects': () => Response.json({ projects: [] }),
    '/api/members': () => Response.json(MEMBERS),
    '/api/enrollment': () => Response.json({ invitations: [] }),
    '/api/status': () => Response.json(status()),
    '/api/credentials': (_init, url) => Response.json({
      rows: url?.searchParams.get('purpose') === 'run' ? credentials.run ?? [] : credentials.member ?? [],
      cursor: null,
    }),
    '/api/machines': () => Response.json({ machines, cursor: null }),
    ...Object.fromEntries(machines.map((row) => [`/api/machines/${row.machineId}`, () => Response.json({ machine: row, contactFacts: 'ready' })])),
    '/api/runners': () => Response.json({ observedAt: NOW_MS, runners: [], legacyWorkers: [], queue: { observedAt: NOW_MS, count: 0, oldestAt: null, reasons: [], nativeNeedsRunner: false }, cursor: null }),
    '/api/runners/removed': () => Response.json({ runners: [], cursor: null }),
    '/api/uncaptured': () => Response.json({ items: [], cursor: null }),
    ...routes,
  });
}

const PEOPLE = '/settings/people';
const ADA_MACHINE = '/settings/people/machines/ada_5a2d54af';

/** Opens a person's Manage menu and answers the menu. */
async function personMenu(name: string): Promise<HTMLElement> {
  const list = await screen.findByRole('list', { name: 'Members' });
  const row = within(list).getAllByRole('listitem').find((item) => item.querySelector('.font-medium')?.firstChild?.textContent === name)!;
  fireEvent.keyDown(within(row).getByRole('button', { name: 'Manage' }), { key: 'Enter' });
  return screen.findByRole('menu');
}

/** Opens the machine page's confirmation to stop it capturing. */
async function openRemove(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Stop capturing…' }));
  return screen.findByRole('dialog', { name: 'Stop Ada’s MacBook capturing?' });
}

/** Opens a ⋯ menu by its name and answers the menu. */
async function openMenu(name: string | RegExp): Promise<HTMLElement> {
  fireEvent.keyDown(await screen.findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
}

/** The items a ⋯ menu offers, closing it after. */
async function menuItems(trigger: HTMLElement): Promise<string[]> {
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  const items = within(menu).getAllByRole('menuitem').map((item) => item.textContent ?? '');
  fireEvent.keyDown(menu, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  return items;
}

describe('members', () => {
  it('lists people with their role and account, marks you, and the remove confirm says what stops', async () => {
    accessServer({});
    mount(PEOPLE);
    const list = await screen.findByRole('list', { name: 'Members' });
    expect(list.textContent).toContain('Ada · Admin · you');
    expect(list.textContent).toContain('Signs in with GitHub · 2 machines');
    expect(list.textContent).toContain('No GitHub account connected yet, so they can’t sign in here · 0 machines');
    const menu = await personMenu('Ada');
    expect(within(menu).queryByRole('menuitem', { name: 'Remove' })).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // Removing another member says their machines stay theirs (#1209).
    fireEvent.click(within(await personMenu('Lin')).getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Lin?' });
    expect(dialog.textContent).toContain(MEMBER_KEEPS_MACHINES);
  });

  it('says the server\'s refusal in the person\'s words, and keeps the confirm open', async () => {
    accessServer({}, { [`/api/members/${LIN}/revoke`]: () => Response.json({ error: 'last_member' }, { status: 409 }) });
    mount(PEOPLE);
    fireEvent.click(within(await personMenu('Lin')).getByRole('menuitem', { name: 'Remove' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Lin?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/nobody who can sign in/);
  });

  it('offers Connect GitHub only for a member with no account yet, and shows the one-time link the admin sends them', async () => {
    const { posts } = accessServer({}, { [`/api/members/${LIN}/link-github`]: () => Response.json({ key: 'k'.repeat(43), expiresAt: NOW_MS + 3_600_000 }, { status: 201 }) });
    mount(PEOPLE);
    const ada = await personMenu('Ada');
    expect(within(ada).queryByRole('menuitem', { name: 'Connect GitHub' })).toBeNull();
    fireEvent.keyDown(ada, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(within(await personMenu('Lin')).getByRole('menuitem', { name: 'Connect GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect a GitHub account to Lin' });
    expect(dialog.textContent).toMatch(/send it only to them/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    const ready = await screen.findByRole('dialog', { name: 'Link ready' });
    expect(ready.querySelector('code')?.textContent).toBe(`${window.location.origin}/link#${'k'.repeat(43)}`);
    expect(ready.textContent).toMatch(/Send this link to Lin/);
    expect(posts).toEqual([{ path: `/api/members/${LIN}/link-github`, body: undefined }]);
  });

  it('says why a link was not created, in the person\'s words', async () => {
    accessServer({}, { [`/api/members/${LIN}/link-github`]: () => Response.json({ error: 'member_linked' }, { status: 409 }) });
    mount(PEOPLE);
    fireEvent.click(within(await personMenu('Lin')).getByRole('menuitem', { name: 'Connect GitHub' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect a GitHub account to Lin' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/already has a GitHub account connected/);
    expect(dialog.querySelector('code')).toBeNull();
  });
});

describe('invitations', () => {
  it('invites a teammate and shows the exact `myco login` command once', async () => {
    const { posts } = accessServer({}, {
      '/api/enrollment': (init) => init?.method === 'POST' ? Response.json({ key: 'k'.repeat(43), id: 'en_1', expiresAt: NOW_MS + 60_000, role: 'member', projectId: null }, { status: 201 }) : Response.json({ invitations: [] }),
    });
    mount(PEOPLE);
    fireEvent.click(await screen.findByRole('button', { name: INVITE_CONTROLS.invite }));
    let dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.invite });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('code')?.textContent).toBe(`myco login ${window.location.origin}/join#${'k'.repeat(43)}`));
    dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('On their machine, run:');
    expect(dialog.textContent).toMatch(/shown only now/);
    expect(posts).toEqual([{ path: '/api/enrollment', body: { ttlMinutes: 60 } }]);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: INVITE_CONTROLS.invite }));
    dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.invite });
    expect(within(dialog).getByRole('button', { name: 'Create invitation' })).toBeTruthy();
    expect(dialog.querySelector('code')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('adds a machine for a member picked in the For field, in the words the member\'s rejoin notice quotes', async () => {
    const { posts } = accessServer({}, {
      '/api/enrollment': (init) => init?.method === 'POST' ? Response.json({ key: 'm'.repeat(43), id: 'en_2', expiresAt: NOW_MS + 86_400_000, role: 'member', projectId: null }, { status: 201 }) : Response.json({ invitations: [] }),
    });
    mount(PEOPLE);
    fireEvent.click(await screen.findByRole('button', { name: INVITE_CONTROLS.button }));
    let dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.button });
    // The viewer is picked first; the field lists every live person.
    const field = within(dialog).getByRole('combobox', { name: new RegExp(`^${INVITE_CONTROLS.field}(?::|$)`) });
    expect(field.textContent).toContain('Ada');
    fireEvent.click(field);
    fireEvent.click(await screen.findByRole('option', { name: 'Lin' }));
    fireEvent.click(within(dialog).getByRole('combobox', { name: /^How\ long\ the\ link\ works(?::|$)/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'For a day' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create link' }));
    await waitFor(() => expect(screen.getByRole('dialog').querySelector('code')?.textContent).toBe(`myco login ${window.location.origin}/join#${'m'.repeat(43)}`));
    dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('On the machine you want to add, run:');
    expect(posts).toEqual([{ path: '/api/enrollment', body: { memberId: LIN, ttlMinutes: 1440 } }]);
    expect(REJOIN_HINT).toContain(`${INVITE_CONTROLS.page} → ${INVITE_CONTROLS.button} → ${INVITE_CONTROLS.field}`);
  });

  it('says a refused invitation in words, inside the dialog', async () => {
    accessServer({}, { '/api/enrollment': (init) => init?.method === 'POST' ? Response.json({ error: 'member_revoked' }, { status: 409 }) : Response.json({ invitations: [] }) });
    mount(PEOPLE);
    fireEvent.click(await screen.findByRole('button', { name: INVITE_CONTROLS.invite }));
    const dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.invite });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create invitation' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('That member has been removed.');
  });

  const invitation = (expiresAt: number, memberId: string | null = null) => ({ id: 'en_1', memberId, createdBy: ADA, createdAt: NOW_MS, expiresAt, role: 'member', projectId: null });

  it('counts down to an invitation 60 minutes out, never "just now", and names whom a machine is for', async () => {
    accessServer({}, { '/api/enrollment': () => Response.json({ invitations: [invitation(Date.now() + 60 * 60_000), invitation(Date.now() + 60 * 60_000, LIN)] }) });
    mount(PEOPLE);
    const list = await screen.findByRole('list', { name: 'Invitations' });
    expect(within(list).getByText('A new teammate')).toBeTruthy();
    expect(within(list).getByText('A machine for Lin')).toBeTruthy();
    expect(within(list).getAllByText(/^by you · expires in (59|60)m$/)).toHaveLength(2);
    expect(list.textContent).not.toMatch(/just now/);
  });

  it('says an invitation past its expiry has expired, not that it expires', async () => {
    accessServer({}, { '/api/enrollment': () => Response.json({ invitations: [invitation(Date.now() - 5 * 60_000)] }) });
    mount(PEOPLE);
    expect(await screen.findByText(/^by you · expired$/)).toBeTruthy();
    expect(screen.queryByText(/expires/)).toBeNull();
  });

  it('withdraws an invitation from its menu, behind a confirm', async () => {
    const { posts } = accessServer({}, {
      '/api/enrollment': () => Response.json({ invitations: [invitation(Date.now() + 60 * 60_000)] }),
      '/api/enrollment/en_1/revoke': () => Response.json({ revoked: true }),
    });
    mount(PEOPLE);
    fireEvent.click(within(await openMenu('More for this invitation')).getByRole('menuitem', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw this invitation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/api/enrollment/en_1/revoke', body: undefined }]));
  });
});

describe('machines', () => {
  it('offers a machine\'s settings once per machine, only on the viewer\'s own, never on one that names none, and saves its approved prompt file folders (#1393)', async () => {
    const puts: { path: string; body: unknown }[] = [];
    let stored: string[] = [];
    accessServer({
      member: [
        credential({ id: 'mt_1aaaaaaaaaaaa', lineageRoot: 'mt_1aaaaaaaaaaaa' }),
        credential({ id: 'mt_2aaaaaaaaaaaa', lineageRoot: 'mt_2aaaaaaaaaaaa', lineageStartedAt: NOW_MS - 2 * 86_400_000 }),
        credential({ id: 'mt_3aaaaaaaaaaaa', lineageRoot: 'mt_3aaaaaaaaaaaa', machineId: null, runtimeLabel: null, lineageStartedAt: NOW_MS - 3 * 86_400_000 }),
        credential({ id: 'mt_4aaaaaaaaaaaa', lineageRoot: 'mt_4aaaaaaaaaaaa', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: 'Lin’s desk', lineageStartedAt: NOW_MS - 1.5 * 86_400_000 }),
      ],
      run: [credential({ id: 'mt_runaaaaaaaaaa', memberId: 'mem_harness', machineId: 'harness', runtimeLabel: null, purpose: 'run' })],
    }, {
      '/api/machines/ada_5a2d54af/settings': () => Response.json({ machineId: 'ada_5a2d54af', leaves: [{ leaf: 'capture.prompt_file_roots', configured: stored.length > 0, value: stored, updatedAt: null, updatedBy: null }] }),
      '/api/machines/ada_5a2d54af/settings/capture.prompt_file_roots': (init) => {
        const body = JSON.parse(String(init?.body)) as { value: string[] };
        puts.push({ path: '/api/machines/ada_5a2d54af/settings/capture.prompt_file_roots', body });
        stored = body.value;
        return Response.json({ applied: true });
      },
    });
    mount(PEOPLE);
    const machines = await screen.findByRole('group', { name: 'Machines' });
    // Two runtimes of one claimed machine are one row; a credential with no claim is not a machine.
    await waitFor(() => expect(within(machines).getAllByRole('link', { name: 'Manage' }).map((link) => link.getAttribute('href'))).toEqual(['/settings/people/machines/lin_77aa00bb', ADA_MACHINE]));
    cleanup();
    mount('/settings/people/machines/lin_77aa00bb');
    await screen.findByRole('heading', { level: 1, name: 'Lin’s desk' });
    expect(screen.queryByRole('button', { name: MACHINE_SETTINGS_CONTROLS.action })).toBeNull();
    cleanup();
    mount(ADA_MACHINE);
    fireEvent.click(await screen.findByRole('button', { name: MACHINE_SETTINGS_CONTROLS.action }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings for Ada’s MacBook' });
    expect(await within(dialog).findByText('None: only project and temporary folders.')).toBeTruthy();
    // A folder that names the whole home is refused before it is ever sent.
    fireEvent.change(within(dialog).getByLabelText('Prompt file folder to add'), { target: { value: '~' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('~/');
    expect(within(dialog).getByText('None: only project and temporary folders.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Prompt file folder to add'), { target: { value: '~/notes/plans' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ path: '/api/machines/ada_5a2d54af/settings/capture.prompt_file_roots', body: { value: ['~/notes/plans'] } }]));
  });

  it('offers the folders a machine captures on its own, at the default until changed, and saves only what changed', async () => {
    const puts: { path: string; body: unknown }[] = [];
    let roots: string[] = ['~/Repos'];
    accessServer({ member: [credential({ id: 'mt_1aaaaaaaaaaaa', lineageRoot: 'mt_1aaaaaaaaaaaa' })] }, {
      '/api/machines/ada_5a2d54af/settings': () => Response.json({ machineId: 'ada_5a2d54af', leaves: [
        { leaf: 'capture.plan_dirs', configured: false, value: [], updatedAt: null, updatedBy: null },
        { leaf: 'capture.auto_join_roots', configured: roots.length !== 1 || roots[0] !== '~/Repos', value: roots, updatedAt: null, updatedBy: null },
        { leaf: 'capture.connect_roots', configured: false, value: {}, updatedAt: null, updatedBy: null },
      ] }),
      '/api/machines/ada_5a2d54af/settings/capture.auto_join_roots': (init) => {
        const body = JSON.parse(String(init?.body)) as { value: string[] };
        puts.push({ path: '/api/machines/ada_5a2d54af/settings/capture.auto_join_roots', body });
        roots = body.value;
        return Response.json({ applied: true });
      },
    });
    mount(ADA_MACHINE);
    fireEvent.click(await screen.findByRole('button', { name: MACHINE_SETTINGS_CONTROLS.action }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings for Ada’s MacBook' });
    const captured = await within(dialog).findByRole('region', { name: 'Folders it captures' });
    expect(within(captured).getByRole('list', { name: 'Folders it captures' }).textContent).toBe('~/Repos');
    // Server-written connections have no folder editor.
    expect(dialog.querySelector('[data-machine-leaf="capture.connect_roots"]')).toBeNull();
    // A folder that does not start at the home or the root is refused before it is ever sent, and so is the whole home.
    for (const [folder, why] of [['Repos', 'starts with ~/, / or a drive'], ['~', 'not the home itself'], ['C:\\', 'not the drive itself']] as const) {
      fireEvent.change(within(captured).getByLabelText('Folder to capture'), { target: { value: folder } });
      fireEvent.click(within(captured).getByRole('button', { name: 'Add' }));
      expect((await within(captured).findByRole('alert')).textContent).toContain(why);
    }
    fireEvent.change(within(captured).getByLabelText('Folder to capture'), { target: { value: '~/work' } });
    fireEvent.click(within(captured).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(captured).getByRole('button', { name: 'Remove ~/Repos' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ path: '/api/machines/ada_5a2d54af/settings/capture.auto_join_roots', body: { value: ['~/work'] } }]));
    fireEvent.click(within(captured).getByRole('button', { name: 'Remove ~/work' }));
    expect(within(captured).getByText('None: every repository waits in Needs you until it’s connected.')).toBeTruthy();
  });

  it('shows effective folders, pending machine values and a neutral repair for unusable stored entries', async () => {
    const puts: unknown[] = [];
    let cleared = false;
    accessServer({ member: [credential()] }, {
      '/api/machines/ada_5a2d54af/settings': () => Response.json({ leaves: [
        { leaf: 'capture.plan_dirs', configured: !cleared, value: cleared ? [] : ['/', 'docs/plans'], stored: cleared ? null : ['/', 'docs/plans'], effective: cleared ? [] : ['docs/plans'], source: cleared ? 'default' : 'invalid', storedApplies: cleared ? null : false, state: cleared ? 'inactive' : 'invalid', reason: cleared ? 'Saved. Applies at the next session start.' : 'Some stored folders cannot be used. Clear the stored value to restore the default.', updatedAt: null, updatedBy: null },
        { leaf: 'capture.auto_join_roots', configured: true, value: ['~/New'], effective: ['~/Old'], nextEffective: ['~/New'], source: 'member-cache', nextSource: 'configured', storedApplies: true, application: 'pending', appliedValue: ['~/Old'], reason: 'Saved. Applies at the next session start.', updatedAt: null, updatedBy: null },
        { leaf: 'capture.connect_roots', configured: true, value: { ['a'.repeat(64)]: 'proj_usable', broken: 7 }, effective: { ['a'.repeat(64)]: 'proj_old' }, nextEffective: { ['a'.repeat(64)]: 'proj_usable' }, application: 'pending', appliedValue: { ['a'.repeat(64)]: 'proj_old' }, nextSource: 'invalid', source: 'member-cache', storedApplies: false, reason: 'Some stored repository connections cannot be used.', updatedAt: null, updatedBy: null },
      ] }),
      '/api/machines/ada_5a2d54af/settings/capture.plan_dirs': (init) => {
        puts.push(JSON.parse(String(init?.body)));
        cleared = true;
        return Response.json({ applied: true });
      },
    });
    mount(ADA_MACHINE);
    fireEvent.click(await screen.findByRole('button', { name: MACHINE_SETTINGS_CONTROLS.action }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings for Ada’s MacBook' });
    const plans = await within(dialog).findByRole('region', { name: 'Extra plan folders' });
    expect(within(plans).getByRole('list').textContent).toBe('docs/plans');
    expect(plans.querySelector('pre') === null).toBe(true);
    fireEvent.click(within(plans).getByRole('button', { name: 'Stored value' }));
    expect(plans.querySelector('pre')?.textContent).toContain('docs/plans');
    expect(within(plans).queryByRole('alert')).toBeNull();
    const roots = within(dialog).getByRole('region', { name: 'Folders it captures' });
    expect(within(roots).getByRole('list').textContent).toBe('~/New');
    expect(within(roots).getByText('This machine currently uses these folders: ~/Old.')).toBeTruthy();
    const connections = within(dialog).getByRole('region', { name: 'Connected repositories' });
    expect(connections.textContent).toContain('1 repository');
    fireEvent.click(within(connections).getByRole('button', { name: 'At next session start' }));
    expect(connections.textContent).toContain('1 repository is configured from Needs you.');
    expect(connections.textContent).toContain('Myco currently uses 1 cached connection.');
    expect(connections.querySelector('pre')?.textContent).toContain('proj_usable');
    expect(connections.querySelector('pre')?.textContent).not.toContain('broken');
    fireEvent.click(within(connections).getByRole('button', { name: 'At next session start' }));
    fireEvent.click(within(connections).getByRole('button', { name: 'Currently applied connections' }));
    expect(connections.querySelector('pre')?.textContent).toContain('proj_old');
    expect(within(connections).getByRole('button', { name: 'Remove entries that no longer apply' })).toBeTruthy();
    fireEvent.click(within(plans).getByRole('button', { name: 'Clear the stored value' }));
    await waitFor(() => expect(puts).toEqual([{ value: null, reset: true }]));
    expect(await within(plans).findByText('The next session uses Myco’s default.')).toBeTruthy();
  });

  it('keeps a list\'s unsaved folders when its save is refused, says so on that list, and saves the other', async () => {
    let plans: string[] = [];
    const puts: string[] = [];
    accessServer({ member: [credential({ id: 'mt_1aaaaaaaaaaaa', lineageRoot: 'mt_1aaaaaaaaaaaa' })] }, {
      '/api/machines/ada_5a2d54af/settings': () => Response.json({ machineId: 'ada_5a2d54af', leaves: [
        { leaf: 'capture.plan_dirs', configured: plans.length > 0, value: plans, updatedAt: null, updatedBy: null },
        { leaf: 'capture.auto_join_roots', configured: false, value: ['~/Repos'], updatedAt: null, updatedBy: null },
      ] }),
      '/api/machines/ada_5a2d54af/settings/capture.auto_join_roots': () => {
        puts.push('capture.auto_join_roots');
        return Response.json({ error: 'bad_request', reason: 'expected at most 16 paths' }, { status: 400 });
      },
      '/api/machines/ada_5a2d54af/settings/capture.plan_dirs': (init) => {
        puts.push('capture.plan_dirs');
        plans = (JSON.parse(String(init?.body)) as { value: string[] }).value;
        return Response.json({ applied: true });
      },
    });
    mount(ADA_MACHINE);
    fireEvent.click(await screen.findByRole('button', { name: MACHINE_SETTINGS_CONTROLS.action }));
    const dialog = await screen.findByRole('dialog', { name: 'Settings for Ada’s MacBook' });
    const captured = await within(dialog).findByRole('region', { name: 'Folders it captures' });
    const planned = within(dialog).getByRole('region', { name: 'Extra plan folders' });
    fireEvent.change(within(captured).getByLabelText('Folder to capture'), { target: { value: '~/work' } });
    fireEvent.click(within(captured).getByRole('button', { name: 'Add' }));
    fireEvent.change(within(planned).getByLabelText('Plan folder to add'), { target: { value: '~/notes/plans' } });
    fireEvent.click(within(planned).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual(['capture.auto_join_roots', 'capture.plan_dirs']));
    expect((await within(captured).findByRole('alert')).textContent).toBe('Not saved: The server could not accept those folders.');
    await waitFor(() => expect(within(planned).getByRole('list', { name: 'Extra plan folders' }).textContent).toBe('~/notes/plans'));
    expect(within(planned).queryByRole('alert')).toBeNull();
    // The refused list keeps what the viewer typed, ready to change and save again.
    expect(within(captured).getByRole('list', { name: 'Folders it captures' }).textContent).toBe('~/Repos~/work');
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists an expired machine as a former one, closed until asked for, and offers it no Stop', async () => {
    accessServer({ member: [credential({ expiresAt: 1, live: false })] });
    mount(PEOPLE);
    fireEvent.click(await screen.findByRole('button', { name: 'Former machines (1)' }));
    const machines = await screen.findByLabelText('Former machines');
    expect(machines.textContent).toContain('Offline');
    cleanup();
    mount(ADA_MACHINE);
    expect((await screen.findByText('Offline')).closest('[data-machine-verdict]')?.textContent).toContain('Its sign-in expired');
    expect(screen.queryByRole('button', { name: 'Stop capturing…' })).toBeNull();
  });

  it('says, before a machine is stopped, how it writes again, and stops every live runtime on it', async () => {
    const { posts } = accessServer({
      member: [credential(), credential({ id: 'mt_Yq7rT2uV5wX8zA1b', lineageRoot: 'mt_Yq7rT2uV5wX8zA1b', lineageStartedAt: NOW_MS - 2 * 86_400_000 })],
    }, {
      '/api/machines/ada_5a2d54af/stop': () => Response.json({ revoked: 2, revokedBy: ADA }),
    });
    mount(ADA_MACHINE);
    const dialog = await openRemove();
    expect(dialog.textContent).toContain(REJOIN_FOR_ADMIN);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop capturing' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/machines/ada_5a2d54af/stop']));
  });

  it('keeps a refused stop in view, in words', async () => {
    accessServer({ member: [credential()] }, { '/api/machines/ada_5a2d54af/stop': () => new Response(null, { status: 503 }) });
    mount(ADA_MACHINE);
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop capturing' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The server refused (503).');
  });

  it('uses the machine Stop decision, including the owner credential protection', async () => {
    const { posts } = accessServer({ member: [credential({ memberId: LIN })] }, {
      '/api/machines/ada_5a2d54af': () => Response.json({ machine: { ...machineRows([credential({ memberId: LIN }) as CredentialRow])[0], canStop: false,
        stopReason: "Only the owner can stop the owner's machines. You can stop your own." }, contactFacts: 'ready' }),
    });
    mount(ADA_MACHINE);
    expect(await screen.findByText(/Only the owner can stop the owner's machines/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop capturing…' })).toBeNull();
    expect(posts).toEqual([]);
  });

  it('keeps a zero-revocation Stop outcome visible as an unsuccessful action', async () => {
    accessServer({ member: [credential()] }, { '/api/machines/ada_5a2d54af/stop': () => Response.json({ revoked: 0, revokedBy: ADA }) });
    mount(ADA_MACHINE);
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop capturing' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('No sign-in was stopped');
    expect(screen.getByRole('dialog', { name: 'Stop Ada’s MacBook capturing?' })).toBeTruthy();
  });

  it('retries one machine-scoped stop after a refusal', async () => {
    const ids = ['mt_StopOne1aaaaaaaa', 'mt_StopTwo2bbbbbbbb', 'mt_StopThree3cccccc'];
    const asked: string[] = [];
    let fails = true;
    const stop = () => {
      asked.push('machine');
      return fails ? new Response(null, { status: 503 }) : Response.json({ revoked: 3, revokedBy: ADA });
    };
    accessServer(
      { member: ids.map((id, i) => credential({ id, lineageRoot: id, lineageStartedAt: NOW_MS - (i + 1) * 60_000 })) },
      { '/api/machines/ada_5a2d54af/stop': stop },
    );
    mount(ADA_MACHINE);
    const dialog = await openRemove();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop capturing' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The server refused (503).');
    expect(asked).toEqual(['machine']);
    fails = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop capturing' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stop Ada’s MacBook capturing?' })).toBeNull());
    expect(asked).toEqual(['machine', 'machine']);
  });

  it('uses the canonical summary when a live sign-in lies beyond the first credential page', async () => {
    const asked: string[] = [];
    const summary = {
        machineId: 'ada_5a2d54af', name: 'Ada’s MacBook', live: true, canStop: true, stopReason: null, member: { id: ADA, label: 'Ada', revoked: false },
        claimedAt: NOW_MS - 90 * 86_400_000, credentialCount: 2, liveCredentialCount: 1, bytesWritten: 0,
        firstSeenAt: NOW_MS - 90 * 86_400_000, standing: 'allowed', stoppedBy: null,
        offers: null, lastContactAt: null, capture: [], lastCaptureAt: null, lastRunAt: null,
      };
    accessServer({}, {
      '/api/machines': () => Response.json({ machines: [summary], cursor: null }),
      '/api/machines/ada_5a2d54af': () => Response.json({ machine: summary, contactFacts: 'ready' }),
      '/api/credentials': (_init, url) => {
        if (url?.searchParams.get('purpose') === 'run') return Response.json({ rows: [], cursor: null });
        const cursor = url?.searchParams.get('cursor') ?? null;
        asked.push(cursor ?? 'first');
        return Response.json(cursor === null ? { rows: [expired], cursor: 'page-2' } : { rows: [live], cursor: null });
      },
    });
    mount(ADA_MACHINE);
    expect(await screen.findByRole('button', { name: 'Stop capturing…' })).toBeTruthy();
    expect(asked).toEqual([]);
  });

  it('lists what every sign-in of a machine wrote, merged newest first', async () => {
    const first = credential({ id: 'mt_WroteOne1aaaaaa', lineageRoot: 'mt_WroteOne1aaaaaa', live: false, expiresAt: NOW_MS - 1_000, lineageStartedAt: NOW_MS - 10 * 86_400_000 });
    const second = credential({ id: 'mt_WroteTwo2bbbbbb', lineageRoot: 'mt_WroteTwo2bbbbbb' });
    const event = (eventId: string, kind: string, createdAt: number) => ({ eventId, projectId: 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11', sessionId: '0f3c2a1b-1111-4222-8333-444455556666', kind, createdAt, receivedAt: createdAt });
    accessServer({ member: [second, first] }, {
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11', name: 'Myco', createdAt: 0, sessionCount: 1, lastActivityAt: NOW_MS, archivedAt: null, archivedBy: null }] }),
      '/api/machines/ada_5a2d54af/activity': () => Response.json({ rows: [event('e-new', 'session.start', NOW_MS - 60_000), event('e-old', 'prompt', NOW_MS - 9 * 86_400_000)], cursor: null }),
    });
    mount(ADA_MACHINE);
    fireEvent.click(await screen.findByRole('button', { name: 'What it sent' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(2));
    const rows = within(dialog).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(rows[0]).toContain('Session started');
    expect(rows[1]).toContain('Prompt');
    expect(rawIdsIn(dialog)).toEqual([]);
  });
});

describe('a machine that captures and runs Myco’s work', () => {
  it('lets a non-owner admin stop its capture and remove its runner as two actions, each saying what carries on', async () => {
    const runner = { id: 'rn_mini', name: 'mini', machineId: 'ada_5a2d54af', state: 'enabled', display: 'Online', connected: true, busy: null, revision: 1, createdAt: NOW_MS, createdBy: ADA, removedAt: null,
      lastSeenAt: NOW_MS, offersObservedAt: NOW_MS, offers: [], os: null, arch: null, version: null, channel: null, latestVersion: null, lastCheckAt: null, lastResult: null, blockedVersion: null, updateState: null, updateRequest: null,
      readiness: { state: 'ready', reason: '', observedAt: NOW_MS }, capabilities: [], labels: [], preference: null, models: [], lastReason: null, lastAttempted: null, lastCompleted: null, lastFailed: null };
    const { posts } = accessServer({ member: [credential()] }, {
      '/api/runners': () => Response.json({ observedAt: NOW_MS, runners: [runner], legacyWorkers: [], queue: { observedAt: NOW_MS, count: 0, oldestAt: null, reasons: [], nativeNeedsRunner: false }, cursor: null }),
      '/api/machines/ada_5a2d54af/stop': () => Response.json({ revoked: 1, revokedBy: ADA }),
      '/api/runners/rn_mini/remove': () => Response.json({ changed: true }),
    });
    mount(ADA_MACHINE);
    const stop = await openRemove();
    expect(stop.textContent).toContain('mini stays registered as a runner; removing it is a separate action.');
    fireEvent.click(within(stop).getByRole('button', { name: 'Stop capturing' }));
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(['/api/machines/ada_5a2d54af/stop']));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove mini…' }));
    const remove = await screen.findByRole('dialog', { name: 'Remove mini as a runner?' });
    expect(remove.textContent).toContain('Capture on this machine continues');
    fireEvent.click(within(remove).getByRole('button', { name: 'Remove mini' }));
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(['/api/machines/ada_5a2d54af/stop', '/api/runners/rn_mini/remove']));
  });
});

describe('Myco\'s runs', () => {
  it('keeps a run\'s own credential out of the machines, in a section of its own', async () => {
    accessServer({
      member: [credential()],
      run: [credential({ id: 'mt_runaaaaaaaaaa', memberId: 'mem_harness', machineId: 'harness', runtimeLabel: null, purpose: 'run', lineageStartedAt: NOW_MS - 5 * 60_000 })],
    });
    mount(PEOPLE);
    const machines = await screen.findByRole('group', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('Ada’s MacBook'));
    expect(machines.textContent).not.toContain('A run started');
    fireEvent.click(await screen.findByRole('button', { name: /^1 run, 1 still signed in/ }));
    const runs = await screen.findByRole('list', { name: 'Sign-ins of Myco’s runs' });
    expect(runs.textContent).toBe('A run started 5 min ago · allowed to write');
  });

  it('shows a machine even when a full page of run credentials was minted after it', async () => {
    const archive = Array.from({ length: 50 }, (_, i) => credential({
      id: `mt_run_${String(i).padStart(10, '0')}`, memberId: 'mem_harness', machineId: 'harness', runtimeLabel: null, purpose: 'run', lineageStartedAt: NOW_MS - i,
    }));
    accessServer({ member: [credential({ lineageStartedAt: NOW_MS - 86_400_000 })], run: archive });
    mount(PEOPLE);
    expect(await within(await screen.findByRole('group', { name: 'Machines' })).findByText('Ada’s MacBook')).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^50 runs, 50 still signed in/ })).toBeTruthy();
  });

  it('stops a run\'s credential from its menu, behind a confirm', async () => {
    const { posts } = accessServer(
      { run: [credential({ id: 'mt_runaaaaaaaaaa', memberId: 'mem_harness', machineId: 'harness', runtimeLabel: null, purpose: 'run' })] },
      { '/api/credentials/mt_runaaaaaaaaaa/revoke': () => Response.json({ revoked: true }) },
    );
    mount(PEOPLE);
    fireEvent.click(await screen.findByRole('button', { name: /^1 run, 1 still signed in/ }));
    fireEvent.click(within(await openMenu('More for this run')).getByRole('menuitem', { name: 'Stop' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop this run’s sign-in?' })).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(posts).toEqual([{ path: '/api/credentials/mt_runaaaaaaaaaa/revoke', body: undefined }]));
  });
});

describe('Connecting a GitHub account', () => {
  it('says a link from before the server had an admin can no longer connect', async () => {
    window.history.replaceState(null, '', `/link#${'k'.repeat(43)}`);
    server({
      '/auth/me': () => Response.json(dashboardMe({ sub: '9002', login: 'newcomer', member: null })),
      '/auth/link': () => Response.json({ error: 'link_requires_admin' }, { status: 403 }),
    });
    mount('/link');
    expect(await screen.findByText(/Ask an owner or admin to connect it from Settings › People and machines/)).toBeTruthy();
  });
});

describe('future instants', () => {
  const now = 1_790_000_000_000;

  it('formatUntil counts a lease in seconds, then minutes, hours and days', () => {
    expect(formatUntil(now + 62_000, now)).toBe('62s');
    expect(formatUntil(now + 1, now)).toBe('1s');
    expect(formatUntil(now + 60 * 60_000, now)).toBe('60m');
    expect(formatUntil(now + 3 * 3_600_000, now)).toBe('3h');
    expect(formatUntil(now + 3 * 86_400_000, now)).toBe('3d');
    expect(formatUntil(now, now)).toBe('now');
  });

  it('formatUntil counts a schedule coarsely: no seconds, and hours from one hour out', () => {
    expect(formatUntil(now + 30_000, now, true)).toBe('1m');
    expect(formatUntil(now + 45 * 60_000, now, true)).toBe('45m');
    expect(formatUntil(now + 119 * 60_000, now, true)).toBe('2h');
  });

  it('an invitation at or past its expiry has expired, and "now" never follows "expires in"', () => {
    expect(invitationExpiry(now, now)).toBe('expired');
    expect(invitationExpiry(now - 1, now)).toBe('expired');
    expect(invitationExpiry(now + 1, now)).toBe('expires in 1s');
    expect(invitationExpiry(now + 60 * 60_000, now)).toBe('expires in 60m');
  });

  it('says how long ago in minutes, hours or days under a week, then the day, and never dates a missing instant', () => {
    const day = 24 * 60 * 60_000;
    expect(agoWords(now + 2 * 60_000, now)).toBe('just now');
    expect([agoWords(now - 5 * 60_000, now), agoWords(now - 1195 * 60_000, now), agoWords(now - 6 * day, now)]).toEqual(['5 min ago', '19 h ago', '6 days ago']);
    expect(agoWords(now - 11 * day, now)).toMatch(/^on [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
    expect([agoWords(0, now), agoWords(null, now), dayWords(0, now), dateTimeWords(undefined, now)]).toEqual(['never', 'never', 'never', 'never']);
  });
});

it('shows reported update preferences separately from waiting changes and confirms them on the next page read', async () => {
  let waiting = false;
  let reported = false;
  accessServer({ member: [credential()] }, {
    '/api/machines/ada_5a2d54af/settings': () => Response.json({ leaves: [
      { leaf: 'update.channel', effective: reported ? 'beta' : 'alpha', nextEffective: waiting ? 'beta' : 'alpha', application: waiting && !reported ? 'pending' : 'applied' },
      { leaf: 'update.automatic', effective: null, nextEffective: null, application: 'unreported' },
    ] }),
    '/api/machines/ada_5a2d54af/settings/update.channel': init => {
      expect(JSON.parse(String(init?.body))).toEqual({ value: 'beta' });
      waiting = true;
      return Response.json({ applied: true });
    },
  });
  mount(ADA_MACHINE);
  let updates = await screen.findByRole('region', { name: 'Updates for Ada’s MacBook' });
  expect(await within(updates).findByText('Automatic updates: Not reported')).toBeTruthy();
  fireEvent.click(within(updates).getByRole('combobox', { name: /^Release channel for Ada/ }));
  fireEvent.click(await screen.findByRole('option', { name: 'beta' }));
  expect(await within(updates).findByText(/Waiting for this machine: release channel/)).toBeTruthy();
  expect(within(updates).getByText('Release channel: alpha · last reported by this machine')).toBeTruthy();
  reported = true;
  cleanup();
  mount(ADA_MACHINE);
  updates = await screen.findByRole('region', { name: 'Updates for Ada’s MacBook' });
  expect(await within(updates).findByText('Release channel: beta · last reported by this machine')).toBeTruthy();
  expect(within(updates).queryByText(/Waiting for this machine/)).toBeNull();
});

it('lists former machines below the live ones, closed and counted, each saying how it stands, and reads no machine settings for the list', async () => {
  const read: string[] = [];
  const old = (id: string, over: Record<string, unknown>) => credential({ id: `mt_${id}aaaaaaaaaa`, lineageRoot: `mt_${id}aaaaaaaaaa`, machineId: `ada_${id}`, expiresAt: 1, live: false, ...over });
  accessServer({ member: [credential(), old('old1', { runtimeLabel: 'Ada’s old laptop' }), old('old2', { runtimeLabel: 'Ada’s old desk', revokedAt: 1, revokedBy: LIN }), old('old3', { runtimeLabel: 'Ada’s copy', revokedAt: 1, revokedBy: 'lineage-replay' })] },
    Object.fromEntries(['ada_5a2d54af', 'ada_old1', 'ada_old2', 'ada_old3'].map((m) => [`/api/machines/${m}/settings`, () => { read.push(m); return Response.json({ leaves: [] }); }])));
  mount(PEOPLE);
  fireEvent.click(await screen.findByRole('button', { name: 'Former machines (3)' }));
  const former = await screen.findByLabelText('Former machines');
  expect(former.textContent).toMatch(/^Ada’s old laptop.*Offline.*Ada’s old desk.*Removed.*Ada’s copy.*Removed/);
  expect(read).toEqual([]);
});

it('offers no update controls on the list of machines', async () => {
  let reads = 0;
  const settings = () => { reads += 1; return Response.json({ leaves: [
    { leaf: 'update.channel', effective: 'alpha', nextEffective: 'alpha', application: 'applied' },
    { leaf: 'update.automatic', effective: true, nextEffective: true, application: 'applied' },
  ] }); };
  accessServer({ member: [credential(), credential({ memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: 'Lin’s desk' })] }, {
    '/api/machines/ada_5a2d54af/settings': settings,
    '/api/machines/lin_77aa00bb/settings': settings,
  });
  mount(PEOPLE);
  const machines = await screen.findByRole('group', { name: 'Machines' });
  await within(machines).findByText('Ada’s MacBook');
  await within(machines).findByText('Lin’s desk');
  expect(screen.queryByRole('combobox', { name: /Automatic updates|Release channel/ })).toBeNull();
  expect(reads).toBe(0);
});
