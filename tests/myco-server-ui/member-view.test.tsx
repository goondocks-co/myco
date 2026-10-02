/**
 * The dashboard as a member who is not an admin sees it (#1491): no page asks a route the route table declares
 * `admin`, and the controls that reach one are not offered, while the read views and their own runtimes stay.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { matchRoute } from '@myco-server-worker/routes.js';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';

const MEMBER = { sub: '770001', login: 'teammate', member: { id: 'mem_2', label: 'teammate', role: 'member' as const } };
const NOW = Date.now();
const PROJECT = { projectId: 'live', name: 'Live', createdAt: 0, sessionCount: 1, lastActivityAt: NOW, archivedAt: null, archivedBy: null };
const EMPTY_ACTIVITY = { items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } };
const CREDENTIAL = { id: 'mt_own', memberId: 'mem_2', machineId: 'laptop', runtimeLabel: null, lineageRoot: 'mt_own', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, bytesWritten: 0, lineageStartedAt: 0, firstUsedAt: null, live: true, purpose: 'member' };

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

/** Every request the dashboard makes, as `METHOD path`; answered from `routes`, else 404. */
function server(routes: Record<string, () => Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    asked.push(`${init?.method ?? 'GET'} ${pathname}`);
    return routes[pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return asked;
}

const ROUTES_ANSWERED: Record<string, () => Response> = {
  '/auth/me': () => Response.json(MEMBER),
  '/api/projects': () => Response.json({ projects: [PROJECT] }),
  '/api/projects/live/activity': () => Response.json(EMPTY_ACTIVITY),
  '/api/members': () => Response.json({ members: [{ id: 'mem_2', label: 'teammate', role: 'member', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 }] }),
  '/api/credentials': () => Response.json({ rows: [CREDENTIAL], cursor: null }),
  '/api/settings': () => Response.json({ leaves: [] }),
  '/api/tasks': () => Response.json({ tasks: [] }),
};

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

/** The requests among `asked` that reach a route only an admin is admitted to. */
const adminRequests = (asked: readonly string[]): string[] => asked.filter((line) => {
  const [method, pathname] = line.split(' ') as [string, string];
  const matched = matchRoute(method, pathname);
  return matched !== null && matched.route.auth === 'session' && matched.route.authority === 'admin';
});

describe('the dashboard for a member who is not an admin', () => {
  const PAGES = [
    '/projects', '/p/live', '/sessions', '/p/live/sessions', '/p/live/sessions/s1', '/p/live/sessions/s1?raw=transcript', '/knowledge', '/knowledge/plans',
    '/p/live/knowledge', '/p/live/knowledge/plans', '/p/live/knowledge/map', '/p/live/spores/sp1', '/p/live/plans/k1', '/p/live/runs', '/work', '/work/tasks', '/p/live/work/tasks', '/p/live/work', '/p/live/work/runs/r1',
    '/me/machines', '/people', '/settings', '/settings/models', '/settings/capture', '/settings/backups', '/settings/access', '/p/live/settings', '/status/health',
    '/p/live/access', '/access', '/status', '/measures', '/settings?tab=secrets', '/operations', '/notifications',
  ];

  it('reads the route table: a request to an admin route is caught, and one to a read view is not', () => {
    expect(adminRequests(['GET /api/secrets', 'POST /api/backups', 'GET /api/projects', 'GET /api/projects/live/sessions'])).toEqual(['GET /api/secrets', 'POST /api/backups']);
  });

  for (const page of PAGES) {
    it(`asks no admin route on ${page}`, async () => {
      const asked = server(ROUTES_ANSWERED);
      mount(page);
      // A run's panel is modal, which hides the page behind it from the accessibility tree.
      await screen.findByRole('navigation', { name: 'Pages', hidden: true });
      // Let every query the page mounts go out before reading what it asked.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(asked.length).toBeGreaterThan(1);
      expect(adminRequests(asked)).toEqual([]);
    });
  }

  it('offers no admin page in the navigation, and says what an admin-only page is instead of showing its controls', async () => {
    server(ROUTES_ANSWERED);
    mount('/p/live/settings');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(pages.textContent).not.toContain('Project settings');
    // The nav foot of admin pages is absent, not greyed out.
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    for (const name of [INVITE_CONTROLS.page, 'Settings', 'Health', 'Project settings']) expect(within(nav).queryByRole('link', { name })).toBeNull();
    expect(await screen.findByTestId('admin-only')).toBeTruthy();
    for (const path of ['/people', '/settings', '/settings/models', '/status/health']) {
      cleanup();
      server(ROUTES_ANSWERED);
      mount(path);
      expect(await screen.findByTestId('admin-only')).toBeTruthy();
      expect(screen.queryAllByRole('switch')).toEqual([]);
    }
  });

  it('lists the member\'s own machines on My machines, with no invitation or removal, and the member\'s own Stop', async () => {
    server(ROUTES_ANSWERED);
    mount('/me/machines');
    expect(await screen.findByRole('heading', { level: 1, name: 'My machines' })).toBeTruthy();
    expect((await screen.findAllByText('A machine')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Invitations')).toBeNull();
    expect(screen.queryByRole('button', { name: INVITE_CONTROLS.button })).toBeNull();
    expect(screen.queryByRole('button', { name: INVITE_CONTROLS.invite })).toBeNull();
    expect(document.body.textContent).not.toContain('laptop');
  });

  it('offers no rename or archive on Projects', async () => {
    server(ROUTES_ANSWERED);
    mount('/projects');
    expect(within(await screen.findByRole('list', { name: 'Projects' })).getByText('Live')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });
});
