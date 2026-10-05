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
import type { Machine } from '../../packages/myco-server/ui/src/features/admin/machines';
import { MachineList } from '../../packages/myco-server/ui/src/features/admin/people/MachineList';
import { canRename, MACHINE_NAME_MAX, machineNameProblem } from '../../packages/myco-server/ui/src/features/admin/people/rename';
import { machineName, MACHINE_NAME_MAX as SERVER_NAME_MAX } from '@myco-server-worker/api/machines.js';
import type { CredentialRow } from '../../packages/myco-server/ui/src/features/admin/wire';
import { rawIdsIn } from '../helpers/raw-ids';
import { machineRows } from './machine-fixtures';

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
  const machineAnswer = (rows: CredentialRow[]) => ({ machines: machineRows(rows.filter((c) => viewer.member.role === 'admin' || c.memberId === viewer.member.id)), cursor: null });
  return server({
    '/auth/me': () => Response.json(viewer),
    '/api/projects': () => Response.json({ projects: [{ projectId: PROJECT, name: 'Myco', createdAt: 0, sessionCount: 1, lastActivityAt: NOW_MS, archivedAt: null, archivedBy: null }] }),
    '/api/members': () => Response.json(MEMBERS),
    '/api/enrollment': () => Response.json({ invitations: [{ id: 'en_Pq8sT3vW', memberId: LIN, createdBy: 'mem_harness', createdAt: NOW_MS, expiresAt: NOW_MS + 3_600_000, role: 'member', projectId: null }] }),
    '/api/status': () => Response.json({ schema: { expected: 1, found: 1, matches: true }, target: 'bun', capabilities: [], projects: [], workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] } }),
    '/api/credentials': (_init, url) => Response.json({ rows: url?.searchParams.get('purpose') === 'run' ? [] : credentials.filter((c) => viewer.member.role === 'admin' || c.memberId === viewer.member.id), cursor: null }),
    '/api/machines': () => Response.json(machineAnswer(credentials)),
    ...extra,
  });
}

/** The requests among `asked` that reach a route only an admin is admitted to. */
const adminRequests = (asked: readonly string[]): string[] => asked.filter((line) => {
  const [method, pathname] = line.split(' ') as [string, string];
  const matched = matchRoute(method, pathname);
  return matched !== null && matched.route.auth === 'session' && matched.route.authority === 'admin';
});

describe('People & machines', () => {
  it('leaves Myco\'s own account out of the people, names it "Myco", and shows no raw id anywhere', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [
      credential(),
      credential({ id: 'mt_Lq2wE4rT6yU8iO0p', lineageRoot: 'mt_Lq2wE4rT6yU8iO0p', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: null }),
    ]);
    mount('/people');
    const people = await screen.findByRole('list', { name: 'Members' });
    expect(within(people).getAllByRole('listitem').map((li) => li.querySelector('.font-medium')?.textContent)).toEqual(['Ada', 'A teammate']);
    expect(people.textContent).not.toMatch(/harness|Myco/);
    // Myco's account appears only by its name: who made an invitation, and who removed a member.
    expect(await screen.findByText(/^by Myco · expires in (59|60)m$/)).toBeTruthy();
    expect(screen.getByText('A machine for a teammate')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Removed (1)' }));
    expect((await screen.findByRole('list', { name: 'Removed members' })).textContent).toMatch(/Roe.*Removed 2 days ago by Myco/);
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('A machine'));
    expect(machines.textContent).toContain('A teammate · allowed to write');
    expect(rawIdsIn(document.body)).toEqual([]);
  });

  it('adds a machine for a member from their menu, with that member picked', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [credential()]);
    mount('/people');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for A teammate' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: `${INVITE_CONTROLS.button} for them` }));
    const dialog = await screen.findByRole('dialog', { name: INVITE_CONTROLS.button });
    expect(within(dialog).getByRole('combobox', { name: INVITE_CONTROLS.field }).textContent).toContain('A teammate');
  });

  it('shows what a machine wrote: what, where and when, with its session linked and no id shown', async () => {
    deployment(me(ADA, 'Ada', 'admin'), [credential()], {
      '/api/machines/ada_5a2d54af/activity': () => Response.json({ rows: [
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

  it('shows a machine from one summary read and pages its merged activity with one request at a time', async () => {
    const history = Array.from({ length: 5_000 }, (_, i) => credential({ id: `past_${i}`, lineageRoot: `past_${i}` }));
    const credentialPurposes: Array<string | null> = [];
    const events = Array.from({ length: 55 }, (_, i) => ({
      eventId: `event_${i}`, projectId: PROJECT, sessionId: SESSION, kind: 'prompt', createdAt: NOW_MS - i, receivedAt: NOW_MS - i,
    }));
    const asked = deployment(me(ADA, 'Ada', 'admin'), [credential()], {
      '/api/credentials': (_init, url) => {
        credentialPurposes.push(url?.searchParams.get('purpose') ?? null);
        const start = Number(url?.searchParams.get('cursor') ?? 0);
        return Response.json({ rows: history.slice(start, start + 50), cursor: start + 50 < history.length ? String(start + 50) : null });
      },
      '/api/machines/ada_5a2d54af/activity': (_init, url) => {
        const start = Number(url?.searchParams.get('cursor') ?? 0);
        return Response.json({ rows: events.slice(start, start + 50), cursor: start + 50 < events.length ? String(start + 50) : null });
      },
    });
    mount('/people');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Ada’s MacBook' }), { key: 'Enter' });
    expect(asked.filter((line) => line === 'GET /api/machines')).toHaveLength(1);
    expect(credentialPurposes).not.toContain('member');
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'What it wrote' }));
    const dialog = await screen.findByRole('dialog', { name: 'What Ada’s MacBook wrote' });
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(50));
    expect(asked.filter((line) => line === 'GET /api/machines/ada_5a2d54af/activity')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(55));
    expect(asked.filter((line) => line === 'GET /api/machines/ada_5a2d54af/activity')).toHaveLength(2);
  });

  it('keeps the first machine activity page with an error and retry when the next page fails', async () => {
    let failNext = true;
    deployment(me(ADA, 'Ada', 'admin'), [credential()], {
      '/api/machines/ada_5a2d54af/activity': (_init, url) => url?.searchParams.has('cursor')
        ? failNext ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ rows: [
          { eventId: 'ev_2', projectId: PROJECT, sessionId: SESSION, kind: 'response', createdAt: NOW_MS - 2, receivedAt: NOW_MS - 2 },
        ], cursor: null })
        : Response.json({ rows: [{ eventId: 'ev_1', projectId: PROJECT, sessionId: SESSION, kind: 'prompt', createdAt: NOW_MS - 1, receivedAt: NOW_MS - 1 }], cursor: '2:next' }),
    });
    mount('/people');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'More for Ada’s MacBook' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'What it wrote' }));
    const dialog = await screen.findByRole('dialog', { name: 'What Ada’s MacBook wrote' });
    await within(dialog).findByText('Prompt');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show more' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Couldn’t refresh it.');
    expect(within(dialog).getByText('Prompt')).toBeTruthy();
    failNext = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await within(dialog).findByText('Reply');
  });

  it('keeps a cached machine summary visible with an error and retry when the next page fails', async () => {
    let failNext = true;
    const ada = credential();
    const lin = credential({ id: 'mt_Lq2wE4rT6yU8iO0p', lineageRoot: 'mt_Lq2wE4rT6yU8iO0p', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: 'Lin’s build box' });
    deployment(me(ADA, 'Ada', 'admin'), [ada], {
      '/api/machines': (_init, url) => url?.searchParams.has('cursor')
        ? failNext ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ machines: machineRows([lin]), cursor: null })
        : Response.json({ machines: machineRows([ada]), cursor: '1:ada_5a2d54af' }),
    });
    mount('/people');
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await within(machines).findByText('Ada’s MacBook');
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Showing the last successful machines read. Couldn’t refresh it.');
    expect(within(machines).getByText('Ada’s MacBook')).toBeTruthy();
    failNext = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await within(machines).findByText('Lin’s build box');
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
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Rename', 'Its settings', 'What it wrote', 'Stop']);
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

describe('Renaming a machine', () => {
  const LINS = credential({ id: 'mt_Lq2wE4rT6yU8iO0p', lineageRoot: 'mt_Lq2wE4rT6yU8iO0p', memberId: LIN, machineId: 'lin_77aa00bb', runtimeLabel: 'Lin’s build box' });

  /** A Deployment whose rename route answers `answer`, renaming the machine on the reads that follow when it is 200. */
  function renaming(viewer: ReturnType<typeof me>, answer: (body: unknown) => Response) {
    let rows = [credential(), LINS];
    const sent: unknown[] = [];
    const asked = deployment(viewer, [], {
      '/api/machines': () => Response.json({ machines: machineRows(rows.filter((c) => viewer.member.role === 'admin' || c.memberId === viewer.member.id)), cursor: null }),
      '/api/machines/lin_77aa00bb': (init) => {
        const body = JSON.parse(String(init?.body));
        sent.push({ method: init?.method, body });
        const response = answer(body);
        if (response.status === 200) rows = rows.map((c) => (c.machineId === 'lin_77aa00bb' ? { ...c, runtimeLabel: body.label } : c));
        return response;
      },
    });
    return { asked, sent };
  }

  async function openRename(owner: string) {
    fireEvent.keyDown(await screen.findByRole('button', { name: `More for ${owner}` }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Rename' }));
    return screen.findByRole('dialog', { name: `Rename ${owner}` });
  }

  it('renames another member\'s machine for an admin, then reads the machines and their capture again', async () => {
    const { asked, sent } = renaming(me(ADA, 'Ada', 'admin'), (body) => Response.json({ machineId: 'lin_77aa00bb', name: (body as { label: string }).label }));
    mount('/people');
    const dialog = await openRename('Lin’s build box');
    const field = within(dialog).getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement;
    expect(field.value).toBe('Lin’s build box');
    expect((within(dialog).getByRole('button', { name: 'Rename' }) as HTMLButtonElement).disabled).toBe(true);
    const before = asked.length;
    fireEvent.change(field, { target: { value: '  build-02  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toEqual([{ method: 'PATCH', body: { label: 'build-02' } }]);
    const machines = await screen.findByRole('list', { name: 'Machines' });
    await waitFor(() => expect(machines.textContent).toContain('build-02'));
    expect(machines.textContent).not.toContain('Lin’s build box');
    expect(asked.slice(before)).toEqual(expect.arrayContaining(['GET /api/machines', 'GET /api/status']));
  });

  it('says what is wrong with a name before sending it, and sends nothing', async () => {
    const { sent } = renaming(me(ADA, 'Ada', 'admin'), () => Response.json({}));
    mount('/people');
    const dialog = await openRename('Lin’s build box');
    const field = within(dialog).getByRole('textbox', { name: 'Machine name' });
    const save = within(dialog).getByRole('button', { name: 'Rename' }) as HTMLButtonElement;
    for (const [value, words] of [
      ['   ', 'Give the machine a name.'],
      ['x'.repeat(MACHINE_NAME_MAX + 1), `A name is at most ${MACHINE_NAME_MAX} characters; this one is ${MACHINE_NAME_MAX + 1}.`],
      ['bell\u0007box', 'A name can’t hold control or invisible characters.'],
      ['zero\u200bwidth', 'A name can’t hold control or invisible characters.'],
      ['a\u0301\u0301\u0301\u0301\u0301', 'A name can’t stack more than four accents on one letter.'],
    ] as const) {
      fireEvent.change(field, { target: { value } });
      expect(within(dialog).getByRole('alert').textContent).toBe(words);
      expect(save.disabled).toBe(true);
      fireEvent.submit(field.closest('form')!);
    }
    // Sixty-four characters, one of them outside the BMP and counted once, is a name.
    fireEvent.change(field, { target: { value: `${'x'.repeat(MACHINE_NAME_MAX - 1)}🖥` } });
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(save.disabled).toBe(false);
    expect(sent).toEqual([]);
  });

  it('says the server\'s refusal in words, and keeps the dialog open to try again', async () => {
    for (const [answer, words] of [
      [Response.json({ error: 'bad_request', reason: 'label must be 1 to 64 printable characters' }, { status: 400 }), 'The server didn’t take that name. A name is 1 to 64 characters, every one of them printable.'],
      [Response.json({ error: 'not_found' }, { status: 404 }), 'This machine is no longer here, or it isn’t yours to rename.'],
      [Response.json({ error: 'internal' }, { status: 503 }), 'The server refused (503).'],
    ] as const) {
      renaming(me(ADA, 'Ada', 'admin'), () => answer.clone());
      mount('/people');
      const dialog = await openRename('Lin’s build box');
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Machine name' }), { target: { value: 'build-02' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe(words);
      expect(screen.getByRole('dialog', { name: 'Rename Lin’s build box' })).toBeTruthy();
      cleanup();
    }
  });

  it('offers a member Rename on their own machines only, and names an unnamed one from empty', async () => {
    deployment(me(LIN, LIN, 'member'), [LINS]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const paging = { isPending: false, error: null, hasMore: false, isFetchingMore: false, more: () => undefined, retry: () => undefined };
    const rows = machineRows([LINS, credential(), credential({ id: 'mt_Uu7yT6rE5wQ4aS3d', lineageRoot: 'mt_Uu7yT6rE5wQ4aS3d', memberId: LIN, machineId: 'lin_99cc11dd', runtimeLabel: null, lineageStartedAt: NOW_MS - 2 * DAY })]);
    const unnamed = rows.filter((row) => row.name === null);
    const listed: Machine[] = rows.map((row) => ({
      key: row.machineId, machineId: row.machineId,
      name: row.name ?? (unnamed.length === 1 ? 'A machine' : `Machine ${unnamed.findIndex((item) => item.machineId === row.machineId) + 1}`),
      named: row.name !== null, memberId: row.member.id, standing: row.standing, stoppedBy: row.stoppedBy,
      firstSeenAt: row.firstSeenAt, liveCredentialCount: row.liveCredentialCount,
      credentialCount: row.credentialCount, bytesWritten: row.bytesWritten,
    }));
    render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter><MachineList machines={listed} viewerId={LIN} nameOf={() => null} showOwner paging={paging} empty="none" /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
    // useMe answers before the menu is read, so the viewer's role is known.
    await waitFor(() => expect(client.getQueryData(['me'])).toBeDefined());
    const menuOf = async (name: string) => {
      fireEvent.keyDown(screen.getByRole('button', { name: `More for ${name}` }), { key: 'Enter' });
      const items = within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      return items;
    };
    expect(await menuOf('Lin’s build box')).toContain('Rename');
    expect(await menuOf('Ada’s MacBook')).not.toContain('Rename');
    fireEvent.keyDown(screen.getByRole('button', { name: 'More for A machine' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Name this machine' });
    expect((within(dialog).getByRole('textbox', { name: 'Machine name' }) as HTMLInputElement).value).toBe('');
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });

  it('decides who may rename: an admin any machine, a member their own, nobody a machine with no id', () => {
    expect(canRename({ machineId: 'm1', memberId: LIN }, ADA, true)).toBe(true);
    expect(canRename({ machineId: 'm1', memberId: LIN }, LIN, false)).toBe(true);
    expect(canRename({ machineId: 'm1', memberId: ADA }, LIN, false)).toBe(false);
    expect(canRename({ machineId: 'm1', memberId: LIN }, null, false)).toBe(false);
    expect(canRename({ machineId: null, memberId: LIN }, ADA, true)).toBe(false);
  });

  it('takes exactly the names the server takes', () => {
    expect(MACHINE_NAME_MAX).toBe(SERVER_NAME_MAX);
    const names = [
      '', ' ', 'a', '  padded  ', 'x'.repeat(64), 'x'.repeat(65), `${'x'.repeat(63)}🖥`, `${'x'.repeat(64)}🖥`, ` ${'x'.repeat(64)} `,
      'tab\there', 'new\nline', 'bell\u0007', 'del\u007f', 'zero\u200bwidth', 'bidi\u202eflip', 'bom\ufeff', 'line\u2028sep', 'para\u2029sep',
      'private\ue000use', 'unassigned\u0378', 'lone\ud800surrogate', 'soft\u00adhyphen',
      'é', 'e\u0301', 'a\u0301\u0301\u0301\u0301', 'a\u0301\u0301\u0301\u0301\u0301', 'नमस्ते', '日本語のマシン', 'Ada’s MacBook', 'build-02.local', '🖥️ desk',
    ];
    expect(names.map((name) => [name, machineNameProblem(name) === null])).toEqual(names.map((name) => [name, machineName(name) !== null]));
  });
});
