import { afterEach, describe, expect, it } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { formatRelative, formatUntil } from '../../packages/myco-server/ui/src/lib/format';
import { invitationExpiry } from '../../packages/myco-server/ui/src/pages/Access';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const MEMBERS = { members: [
  { id: 'mem_1', label: 'chris', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 2 },
  { id: 'mem_2', label: 'laptop', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0 },
] };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** One stubbed endpoint. It is handed the request's own URL so a test can answer what the page actually asked for. */
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

describe('Deployment Access', () => {
  it('lists members in user vocabulary, marks you, and the remove confirm says what stops', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/enrollment': () => Response.json({ invitations: [] }),
      '/api/credentials': () => Response.json({ rows: [], cursor: null }),
    });
    mount('/access');
    expect(await screen.findByText('chris')).toBeTruthy();
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.getByText('2 runtimes')).toBeTruthy();
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    expect(await screen.findByText('Remove yourself?')).toBeTruthy();
    expect(screen.getByText(/can no longer sign in/)).toBeTruthy();
  });

  it('mints an invitation and shows the key once', async () => {
    const { posts } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/enrollment': (init) => init?.method === 'POST' ? Response.json({ key: 'k'.repeat(43), id: 'en_1', expiresAt: Date.now() + 60_000 }, { status: 201 }) : Response.json({ invitations: [] }),
      '/api/credentials': () => Response.json({ rows: [], cursor: null }),
    });
    mount('/access');
    fireEvent.click(await screen.findByText('Invite'));
    fireEvent.click(await screen.findByText('Create invitation'));
    expect((await screen.findByTestId('key-reveal')).textContent).toBe('k'.repeat(43));
    expect(screen.getByText(/shown once/)).toBeTruthy();
    expect(posts).toEqual([{ path: '/api/enrollment', body: { ttlMinutes: 60 } }]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByTestId('key-reveal')).toBeNull();
    fireEvent.click(screen.getByText('Invite'));
    expect(await screen.findByText('Create invitation')).toBeTruthy();
    expect(screen.queryByTestId('key-reveal')).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it('says the server\'s refusal in the person\'s words, and offers no Stop for an expired runtime', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/members/mem_1/revoke': () => Response.json({ error: 'last_member' }, { status: 409 }),
      '/api/enrollment': () => Response.json({ invitations: [] }),
      '/api/credentials': (_init, url) => Response.json({
        rows: url?.searchParams.get('purpose') === 'run' ? []
          : [{ id: 'mt_1', memberId: 'mem_1', machineId: 'old-laptop', expiresAt: 1, revokedAt: null, revokedBy: null, bytesWritten: 0, lineageStartedAt: 0, firstUsedAt: null, live: false, purpose: 'member' }],
        cursor: null,
      }),
    });
    mount('/access');
    expect(await screen.findByText('old-laptop')).toBeTruthy();
    expect(screen.getByText('expired')).toBeTruthy();
    expect(screen.queryByText('Stop')).toBeNull();
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/nobody who can sign in/)).toBeTruthy();
  });
});

describe('Project Access', () => {
  it('lists external agents with when they were last used, and adding one shows the key once', async () => {
    const { posts } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 0, lastActivityAt: null }] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/projects/proj_1/grants': (init) => init?.method === 'POST'
        ? Response.json({ key: 'mycoext_' + 'x'.repeat(43), id: 'eg_2' }, { status: 201 })
        : Response.json({ grants: [{ id: 'eg_1', projectId: 'proj_1', label: 'review bot', createdBy: 'mem_1', createdAt: 0, lastUsedAt: null, revokedAt: null, revokedBy: null, rotatedTo: null }] }),
    });
    mount('/p/proj_1/access');
    expect(await screen.findByText('review bot')).toBeTruthy();
    expect(screen.getByText(/never used/)).toBeTruthy();
    fireEvent.click(screen.getByText('Add external agent'));
    fireEvent.click(await screen.findByText('Create key'));
    expect((await screen.findByTestId('key-reveal')).textContent).toBe('mycoext_' + 'x'.repeat(43));
    expect(posts).toEqual([{ path: '/api/projects/proj_1/grants', body: {} }]);
  });

  it('rotates from a confirm and shows the new key once', async () => {
    const { posts } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 0, lastActivityAt: null }] }),
      '/api/members': () => Response.json(MEMBERS),
      '/api/projects/proj_1/grants': () => Response.json({ grants: [{ id: 'eg_1', projectId: 'proj_1', label: 'review bot', createdBy: 'mem_1', createdAt: 0, lastUsedAt: 5, revokedAt: null, revokedBy: null, rotatedTo: null }] }),
      '/api/projects/proj_1/grants/eg_1/rotate': () => Response.json({ key: 'mycoext_' + 'y'.repeat(43), id: 'eg_2', rotatedFrom: 'eg_1' }, { status: 201 }),
    });
    mount('/p/proj_1/access');
    fireEvent.click(await screen.findByText('Rotate'));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate' }));
    expect((await screen.findByTestId('key-reveal')).textContent).toBe('mycoext_' + 'y'.repeat(43));
    expect(posts).toEqual([{ path: '/api/projects/proj_1/grants/eg_1/rotate', body: undefined }]);
  });
});

/**
 * What a runtime's two records say, and what neither of them says.
 *
 * A credential's own record answers what it is allowed to do; the worker record
 * answers what this server last heard it doing. A runtime missing from the
 * worker record has no contact recorded — an observation is kept for a bounded
 * time, so its absence is not evidence that it never claimed a run — and a
 * server that cannot be asked is unknown rather than empty. A run's own
 * credential belongs to its run, not to a machine.
 */
const NOW_MS = Date.now();
const FLEET_WORKER = {
  credentialId: 'mt_1', machineId: 'sirkirby-mbp', offers: [{ id: 'codex', authenticated: true }], capabilities: [],
  lastReason: 'no_work', lastSeenAt: NOW_MS - 3_000, busy: null, eligible: true, recent: true,
};
const statusRoute = (over: Record<string, unknown> = {}) => () => Response.json({
  schema: { expected: 44, found: 44, matches: true }, capabilities: [],
  workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [FLEET_WORKER], ...over },
  projects: [],
});
const credential = (over: Record<string, unknown> = {}) => ({
  id: 'mt_1', memberId: 'mem_1', machineId: 'sirkirby-mbp', expiresAt: NOW_MS + 86_400_000, revokedAt: null, revokedBy: null,
  bytesWritten: 0, lineageStartedAt: NOW_MS - 86_400_000, firstUsedAt: null, live: true, purpose: 'member', ...over,
});
const ADMIN_MEMBERS = { members: [{ ...MEMBERS.members[0], role: 'admin' }, { ...MEMBERS.members[1], role: 'member' }] };

/** A Deployment whose credentials answer per purpose, as the route does. */
function accessServer(credentials: { member?: unknown[]; run?: unknown[] }, routes: Record<string, Endpoint> = {}) {
  return server({
    '/auth/me': () => Response.json(ME),
    '/api/projects': () => Response.json({ projects: [] }),
    '/api/members': () => Response.json(ADMIN_MEMBERS),
    '/api/enrollment': () => Response.json({ invitations: [] }),
    '/api/status': statusRoute(),
    '/api/credentials': (_init, url) => Response.json({
      rows: url?.searchParams.get('purpose') === 'run' ? credentials.run ?? [] : credentials.member ?? [],
      cursor: null,
    }),
    ...routes,
  });
}

describe('a runtime and the worker record beside it', () => {
  it('says a valid credential is allowed to write, and never that it is writing', async () => {
    accessServer({ member: [credential()] });
    mount('/access');
    expect(await screen.findByText('allowed to write')).toBeTruthy();
    expect(screen.queryByText('writing')).toBeNull();
  });

  it('shows what the worker last reported in the same words Status uses', async () => {
    accessServer({ member: [credential()] });
    mount('/access');
    expect(await screen.findByText(/sirkirby-mbp · Polling for work · Last contact \d+s ago/)).toBeTruthy();
    expect(screen.getByText(/Reported authenticated: Codex\./)).toBeTruthy();
    expect(screen.getByText(/Provider access has not been tested by this check\./)).toBeTruthy();
    expect(screen.getByText(/not what every worker can run/)).toBeTruthy();
  });

  it('reports a runtime the worker record does not hold as having no contact recorded', async () => {
    accessServer({ member: [credential()] }, { '/api/status': statusRoute({ fleet: [] }) });
    mount('/access');
    expect(await screen.findByText('No worker contact recorded.')).toBeTruthy();
    // Nothing here knows whether it ever claimed a run.
    expect(screen.queryByText(/never claimed/i)).toBeNull();
  });

  it('says the worker record is unavailable rather than empty when the server cannot be asked', async () => {
    accessServer({ member: [credential()] }, {
      '/api/status': () => Response.json({
        schema: { expected: 44, found: null, matches: false }, capabilities: [],
        workers: { available: false, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] }, projects: [],
      }),
    });
    mount('/access');
    expect(await screen.findByText(/Worker contact unavailable/)).toBeTruthy();
    expect(screen.queryByText('No worker contact recorded.')).toBeNull();
  });

  it('keeps a run\'s own credential out of the runtimes list and in a section of its own', async () => {
    accessServer({
      member: [credential()],
      run: [credential({ id: 'mt_run', memberId: 'mem_harness', machineId: 'harness', purpose: 'run' })],
    });
    mount('/access');
    const runtimes = await screen.findByLabelText('Runtimes');
    expect(runtimes.textContent).toContain('sirkirby-mbp');
    expect(runtimes.textContent).not.toContain('mt_run');
    expect(screen.getByLabelText('Run credentials').textContent).toContain('mt_run');
  });

  it('shows an attached worker even when a full page of run credentials was minted after it', async () => {
    // The archive of run credentials is asked for separately, so a burst of them
    // cannot push a machine's runtime off the list.
    const archive = Array.from({ length: 50 }, (_, i) => credential({
      id: `mt_run_${i}`, memberId: 'mem_harness', machineId: 'harness', purpose: 'run', lineageStartedAt: NOW_MS - i,
    }));
    accessServer({ member: [credential({ lineageStartedAt: NOW_MS - 86_400_000 })], run: archive });
    mount('/access');
    const runtimes = await screen.findByLabelText('Runtimes');
    expect(runtimes.textContent).toContain('sirkirby-mbp');
    expect(await screen.findByText(/sirkirby-mbp · Polling for work/)).toBeTruthy();
    expect(screen.getByLabelText('Run credentials').textContent).toContain('mt_run_0');
  });

  it('does not show a cached worker record as current after the refresh fails', async () => {
    const cached = { schema: { expected: 44, found: 44, matches: true }, capabilities: [], workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [FLEET_WORKER] }, projects: [] };
    accessServer({ member: [credential()] }, { '/api/status': () => new Response(null, { status: 500 }) });
    mount('/access', (client) => client.setQueryData(['status'], cached));
    expect(await screen.findByText(/Worker contact unavailable/)).toBeTruthy();
    expect(screen.queryByText(/Polling for work/)).toBeNull();
  });

  it('marks which members hold the role a worker\'s credential needs', async () => {
    accessServer({});
    mount('/access');
    expect(await screen.findByText('admin')).toBeTruthy();
  });
});

describe('an open invitation says when it stops working', () => {
  const invitation = (expiresAt: number) => ({ id: 'en_1', memberId: null, createdBy: 'mem_1', createdAt: Date.now(), expiresAt, role: 'member', projectId: null });

  it('counts down to an invitation 60 minutes out, never "just now"', async () => {
    accessServer({}, { '/api/enrollment': () => Response.json({ invitations: [invitation(Date.now() + 60 * 60_000)] }) });
    mount('/access');
    expect(await screen.findByText(/by chris · expires in (59|60)m$/)).toBeTruthy();
    expect(screen.queryByText(/just now/)).toBeNull();
  });

  it('says an invitation past its expiry has expired, not that it expires', async () => {
    accessServer({}, { '/api/enrollment': () => Response.json({ invitations: [invitation(Date.now() - 5 * 60_000)] }) });
    mount('/access');
    expect(await screen.findByText(/by chris · expired$/)).toBeTruthy();
    expect(screen.queryByText(/expires/)).toBeNull();
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

  it('formatRelative reads a future instant as just now, since a capturing clock can run ahead', () => {
    expect(formatRelative(now + 2 * 60_000, now)).toBe('just now');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
  });
});
