import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { recencyOf, shownProjects } from '../../packages/myco-server/ui/src/design';
import {
  clearProjectHref, keptFilters, pageSuffix, projectOf, switchProjectHref, titleOf,
} from '../../packages/myco-server/ui/src/routes/nav';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'machine_1', role: 'admin' as const } };
const MEMBER = { sub: '770001', login: 'lin', member: { id: 'mem_2', label: 'Lin', role: 'member' as const } };
const me = (body: unknown = ME, status = 200) => () => Response.json(body, { status });
const NOW = Date.now();
const project = (projectId: string, name: string, sessionCount: number, lastActivityAt: number | null) =>
  ({ projectId, name, createdAt: 0, sessionCount, lastActivityAt, archivedAt: null, archivedBy: null });
const PROJECTS = [project('alpha', 'Alpha', 681, NOW - 60_000), project('beta', 'Beta', 194, NOW - 2 * 86_400_000)];
const EMPTY_ACTIVITY = { items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } };

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  window.location.hash = '';
  forgetProject();
});

/** Answers each path from the table; anything else is 404. Restored after every test so no sibling sees it. */
function server(routes: Record<string, () => Response>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    return routes[pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
}

const signedIn = (who: unknown = ME): Record<string, () => Response> => ({
  '/auth/me': me(who),
  '/api/projects': () => Response.json({ projects: PROJECTS }),
  '/api/projects/alpha/activity': () => Response.json(EMPTY_ACTIVITY),
  '/api/projects/beta/activity': () => Response.json(EMPTY_ACTIVITY),
  '/api/projects/alpha/sessions': () => Response.json({ rows: [], cursor: null }),
  '/api/projects/beta/sessions': () => Response.json({ rows: [], cursor: null }),
});

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppearanceProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    </AppearanceProvider>,
  );
}

/** A screen the given width wide, as far as the dashboard's media queries can tell. */
function screenWidth(width: number): void {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max === null || width <= Number(max[1])) && (min === null || width >= Number(min[1]));
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
}

const location = () => screen.getByTestId('location').textContent;
const filterItems = () => within(screen.getByRole('navigation', { name: 'Projects' })).getAllByRole('link').filter((a) => a.hasAttribute('data-project-filter-item'));

describe('the dashboard shell', () => {
  it('hands a member with no projects to myco setup', async () => {
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    expect(await screen.findByText('No projects yet')).toBeTruthy();
    expect(await screen.findByText('myco setup')).toBeTruthy();
  });

  it('shows the sign-in state when the server answers 401', async () => {
    server({ '/auth/me': () => new Response(null, { status: 401 }), '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    const link = await screen.findByText('Sign in with GitHub');
    expect(link.getAttribute('href')).toBe('/auth/login');
  });

  it('lists projects and links each to its home', async () => {
    server({
      '/auth/me': me(),
      '/api/projects': () => Response.json({ projects: [{ projectId: 'proj_1', name: 'Alpha', createdAt: 0, sessionCount: 3, lastActivityAt: null }] }),
    });
    mount('/projects');
    const card = within(await screen.findByRole('list', { name: 'Projects' })).getByRole('link', { name: /Alpha/ });
    expect(card.getAttribute('href')).toBe('/p/proj_1');
    expect(screen.getByText('3 sessions')).toBeTruthy();
  });

  it('tells a signed-in account that no member is linked to it, naming each way in, and never shows the shell', async () => {
    server({ '/auth/me': me({ ...ME, member: null }), '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    expect(await screen.findByText(/isn.t connected to a member yet/)).toBeTruthy();
    // A member exists once a machine joins, so the first step is an invitation redeemed by myco login.
    expect(screen.getByText('myco login <link>')).toBeTruthy();
    expect(document.body.textContent).toContain('connect your GitHub account from the Members page');
    expect(screen.getByText('myco member link-github')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('serves the link page to a signed-in non-member: the confirm names the member the key was minted for, and the key is never sent until confirmed', async () => {
    const posts: unknown[] = [];
    server({
      '/auth/me': me({ ...ME, member: null }),
      '/auth/link': () => Response.json({ preview: { member: { id: 'mem_2', label: 'laptop' } } }),
    });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return inner(input, init);
    }) as typeof fetch;
    window.location.hash = '#' + 'k'.repeat(43);
    mount('/link');
    expect(await screen.findByText(/Connect this account/)).toBeTruthy();
    expect(screen.getByText('laptop')).toBeTruthy();
    expect(posts).toEqual([{ key: 'k'.repeat(43) }]);
    window.sessionStorage.clear();
  });

  it('lands a pending link on /link after sign-in rather than on the member gate', async () => {
    window.sessionStorage.setItem('myco-pending-link', 'k'.repeat(43));
    server({ '/auth/me': () => new Response(null, { status: 401 }) });
    mount('/');
    expect(await screen.findByText('Connect your GitHub account')).toBeTruthy();
    expect(await screen.findByText('Sign in with GitHub')).toBeTruthy();
    window.sessionStorage.clear();
  });

  it('says so when a project address names nothing', async () => {
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/p/nope');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});

describe('the nav', () => {
  it('shows an admin the pages, the project filter with counts, the admin foot, search and the account', async () => {
    server(signedIn());
    mount('/p/alpha/sessions');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Sessions', 'Spores', 'Plans', 'Agent runs', 'Access']);
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(filterItems().map((a) => a.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]);
    expect(filterItems()[0]!.getAttribute('aria-current')).toBe('true');
    expect(filterItems()[1]!.textContent).toContain('194');
    // The dot says recency in words, never by colour alone.
    expect(within(filterItems()[0]!).getByRole('img', { name: 'Active in the last hour' })).toBeTruthy();
    expect(within(filterItems()[1]!).getByRole('img', { name: 'No activity today' })).toBeTruthy();
    const admin = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(admin).getAllByRole('link').map((a) => a.textContent)).toEqual(['Members', 'Settings', 'Status', 'Measures', 'Operations']);
    expect(screen.getByRole('button', { name: /Search/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account and appearance for machine_1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('hides every admin page from a member: no Access, no Members, Settings, Status, Measures or Operations', async () => {
    server(signedIn(MEMBER));
    mount('/p/alpha');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Sessions', 'Spores', 'Plans', 'Agent runs']);
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    for (const name of ['Access', 'Members', 'Settings', 'Status', 'Measures', 'Operations']) expect(within(nav).queryByRole('link', { name })).toBeNull();
  });

  it('keeps the last project in the page links on a page that spans the server, and marks none of the filter picked', async () => {
    server(signedIn());
    window.localStorage.setItem('myco-last-project', 'beta');
    mount('/status');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('href')).toBe('/p/beta/sessions');
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(filterItems().filter((a) => a.getAttribute('aria-current') === 'true')).toEqual([]);
    expect(filterItems()[1]!.getAttribute('href')).toBe('/p/beta');
  });
});

describe('the project filter', () => {
  it('narrows the page to a picked project, keeping the list filters and dropping the open record; picking it again clears', async () => {
    server(signedIn());
    mount('/p/alpha/sessions?q=fix&state=ended&tab=plans&offset=25');
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    fireEvent.click(filterItems()[1]!);
    await waitFor(() => expect(location()).toBe('/p/beta/sessions?q=fix&state=ended'));
    expect(filterItems()[1]!.getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(window.localStorage.getItem('myco-last-project')).toBe('beta'));
    // Picked again, the filter clears; until a page has an all-projects form, that is the Projects list.
    fireEvent.click(filterItems()[1]!);
    await waitFor(() => expect(location()).toBe('/projects'));
  });

  it('works out every link from the path and the query string', () => {
    expect([projectOf('/p/a%2Fb/sessions/s1'), projectOf('/settings'), pageSuffix('/p/x'), pageSuffix('/p/x/runs/r1')]).toEqual(['a/b', null, '', '/runs']);
    expect(keptFilters('?tab=plans&q=fix&turn=t1&state=open&offset=25&type=gotcha')).toBe('?q=fix&state=open&type=gotcha');
    expect(keptFilters('?tab=plans')).toBe('');
    expect(switchProjectHref({ pathname: '/p/x/spores/sp1', search: '?status=all&q=cache' }, 'y')).toBe('/p/y/spores?status=all&q=cache');
    expect(switchProjectHref({ pathname: '/p/x', search: '' }, 'a/b')).toBe('/p/a%2Fb');
    expect(switchProjectHref({ pathname: '/settings', search: '?tab=secrets' }, 'y')).toBe('/p/y');
    expect(clearProjectHref({ pathname: '/p/x/sessions', search: '?q=fix' })).toBe('/projects');
  });

  it('lists the eight most recent and keeps the picked one among them', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ id: i, active: i === 9 }));
    expect(shownProjects(items).map((item) => item.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 9]);
    expect(shownProjects(items.map((item) => ({ ...item, active: item.id === 2 }))).map((item) => item.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect([recencyOf(null, NOW).label, recencyOf(NOW - 1000, NOW).label, recencyOf(NOW - 3 * 3_600_000, NOW).label, recencyOf(NOW - 30 * 3_600_000, NOW).label])
      .toEqual(['No sessions yet', 'Active in the last hour', 'Active today', 'No activity today']);
  });

  it('says "N more" past eight projects and links to the list of every project', async () => {
    const many = Array.from({ length: 11 }, (_, i) => project(`p${i}`, `Project ${String(i).padStart(2, '0')}`, i, NOW - i * 60_000));
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: many }) });
    mount('/status');
    await waitFor(() => expect(filterItems()).toHaveLength(8));
    const more = within(screen.getByRole('navigation', { name: 'Projects' })).getByRole('link', { name: '3 more' });
    expect(more.getAttribute('href')).toBe('/projects');
  });
});

describe('the page titles', () => {
  it('names every page under a project and every server page, and says not found for the rest', () => {
    expect([
      titleOf('/p/x'), titleOf('/p/x/'), titleOf('/p/x/sessions'), titleOf('/p/x/sessions/abc'), titleOf('/p/x/plans'),
      titleOf('/p/x/spores'), titleOf('/p/x/spores/sp1'), titleOf('/p/x/runs/r1'), titleOf('/p/x/access'), titleOf('/p/x/nope'),
      titleOf('/projects'), titleOf('/status'), titleOf('/measures'), titleOf('/access'), titleOf('/settings'), titleOf('/operations'), titleOf('/nope'),
    ]).toEqual([
      'Overview', 'Overview', 'Sessions', 'Sessions', 'Plans',
      'Spores', 'Spores', 'Agent runs', 'Access', 'Not found',
      'Projects', 'Status', 'Measures', 'Members', 'Settings', 'Operations', 'Not found',
    ]);
  });
});

describe('on a phone', () => {
  it('puts the main pages on a bottom bar, the page title in the header, and the rest of the nav behind More', async () => {
    screenWidth(390);
    server(signedIn());
    mount('/p/alpha/sessions');
    const bar = await screen.findByRole('navigation', { name: 'Main pages' });
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Overview', 'Sessions', 'Spores']);
    expect(within(bar).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('complementary', { name: 'Navigation' })).toBeNull();
    expect(screen.getByRole('banner').textContent).toContain('Sessions');
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Admin' })).toBeTruthy();
    expect(within(drawer).getByRole('navigation', { name: 'Projects' })).toBeTruthy();
    // Following a link closes the drawer.
    fireEvent.click(within(within(drawer).getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Plans' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull());
    expect(location()).toBe('/p/alpha/plans');
  });

  it('opens the nav from a menu button on a tablet, where there is no bottom bar', async () => {
    screenWidth(800);
    server(signedIn());
    mount('/p/alpha');
    fireEvent.click(await screen.findByRole('button', { name: 'Open navigation' }));
    expect(await screen.findByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main pages' })).toBeNull();
  });
});

describe('the account menu', () => {
  it('holds the appearance, the member\'s machines and sign out; the font choice is the code font', async () => {
    server(signedIn());
    mount('/p/alpha');
    const trigger = await screen.findByRole('button', { name: 'Account and appearance for machine_1' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('@octocat · Admin')).toBeTruthy();
    for (const name of ['Light', 'Dark', 'System', 'Sage', 'Terracotta', 'Compact', 'Normal', 'Comfy']) expect(within(menu).getByRole('menuitemradio', { name })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: /Code font/ }).textContent).toContain('JetBrains Mono');
    expect(within(menu).getByRole('menuitem', { name: 'My machines' })).toBeTruthy();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Light' }));
    await waitFor(() => expect(document.documentElement.classList.contains('light')).toBe(true));
    expect(JSON.parse(window.localStorage.getItem('myco-appearance')!).mode).toBe('light');
    document.documentElement.classList.remove('light');
    window.localStorage.removeItem('myco-appearance');
  });
});

describe('/notifications', () => {
  it('redirects to the start, which lands on the last project or the Projects list', async () => {
    server(signedIn());
    mount('/notifications');
    await waitFor(() => expect(location()).toBe('/projects'));
    expect(screen.queryByText(/Notifications/)).toBeNull();
  });
});

describe('/join', () => {
  const KEY = 'k'.repeat(43);

  it('hands over the exact command for the machine joining, with a copy button, and needs no sign-in', async () => {
    const copied: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    server({ '/auth/me': () => new Response(null, { status: 401 }) });
    window.location.hash = `#${KEY}`;
    mount('/join');
    expect(await screen.findByRole('heading', { name: 'Connect a machine to Myco' })).toBeTruthy();
    expect(screen.getByText('On the machine you want to connect, run:')).toBeTruthy();
    const command = `myco login http://localhost/join#${KEY}`;
    expect(screen.getByText(command)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copied).toEqual([command]));
    expect(await screen.findByText('Copied')).toBeTruthy();
    expect(screen.getByText(/works once and then expires/)).toBeTruthy();
    expect(screen.queryByText('Sign in with GitHub')).toBeNull();
  });

  it('says a link without its key carries no invitation, and offers no command', async () => {
    server({ '/auth/me': me() });
    mount('/join');
    expect(await screen.findByRole('heading', { name: 'This link carries no invitation' })).toBeTruthy();
    expect(screen.queryByText(/myco login/)).toBeNull();
  });
});
