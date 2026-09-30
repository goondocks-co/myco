import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { ProjectFilter, recencyOf, shownProjects } from '../../packages/myco-server/ui/src/design';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
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
  '/api/sessions': () => Response.json({ rows: [], cursor: null }),
  '/api/members': () => Response.json({ members: [] }),
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
/** An element in a few words, so a focus assertion that fails says where focus went. */
const describeFocus = (el: Element | null) => (el === null ? 'nothing' : `${el.tagName.toLowerCase()} "${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 40)}"`);
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
    const list = await screen.findByRole('list', { name: 'Projects' });
    const card = within(list).getByRole('link', { name: /Alpha/ });
    expect(card.getAttribute('href')).toBe('/p/proj_1');
    expect(within(list).getByText('3 sessions')).toBeTruthy();
  });

  it('tells a signed-in account that no member is linked to it, naming each way in, and never shows the shell', async () => {
    server({ '/auth/me': me({ ...ME, member: null }), '/api/projects': () => new Response(null, { status: 401 }) });
    mount('/projects');
    expect(await screen.findByText(/isn.t connected to a member yet/)).toBeTruthy();
    // A member exists once a machine joins, so the first step is an invitation redeemed by myco login.
    expect(screen.getByText('myco login <link>')).toBeTruthy();
    expect(document.body.textContent).toContain(`connect your GitHub account from the ${INVITE_CONTROLS.page} page`);
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
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Today', 'Sessions', 'Knowledge', 'Agent runs', 'Project settings']);
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    expect(within(pages).getByRole('link', { name: 'Project settings' }).getAttribute('href')).toBe('/p/alpha/settings');
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(filterItems().map((a) => a.textContent)).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]);
    expect(filterItems()[0]!.getAttribute('aria-current')).toBe('true');
    expect(filterItems()[1]!.textContent).toContain('194');
    expect(within(filterItems()[1]!).getByText('194 sessions').className).toContain('sr-only');
    // The dot says recency in words, never by colour alone.
    expect(within(filterItems()[0]!).getByRole('img', { name: 'Active in the last hour' })).toBeTruthy();
    expect(within(filterItems()[1]!).getByRole('img', { name: 'No activity today' })).toBeTruthy();
    const admin = screen.getByRole('navigation', { name: 'Admin' });
    expect(within(admin).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      [INVITE_CONTROLS.page, '/people'], ['Settings', '/settings'], ['Health', '/status/health'],
    ]);
    expect(screen.getByRole('button', { name: /Search/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account and appearance for machine_1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe('#main');
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('carries the count of what needs an admin beside Health, and nothing when nothing does', async () => {
    const item = { kind: 'backup_overdue', tone: 'warn', lastBackupAt: null, intervalHours: 24 };
    server({ ...signedIn(), '/api/attention': () => Response.json({ items: [item, { ...item }], unavailable: [] }) });
    mount('/p/alpha/sessions');
    const admin = await screen.findByRole('navigation', { name: 'Admin' });
    await waitFor(() => expect(within(admin).getByRole('link', { name: /^Health/ }).textContent).toBe('Health2 things need you'));
    cleanup();
    server({ ...signedIn(), '/api/attention': () => Response.json({ items: [], unavailable: [] }) });
    mount('/p/alpha/sessions');
    const quiet = await screen.findByRole('navigation', { name: 'Admin' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(quiet).getByRole('link', { name: /^Health/ }).textContent).toBe('Health');
  });

  it('leads the old addresses to the pages that hold them now, keeping a measures window', async () => {
    for (const [from, to] of [
      ['/status', '/status/health'], ['/measures?window=7', '/status/health?window=7'], ['/operations', '/status/health'],
      ['/access', '/people'], ['/p/alpha/access', '/p/alpha/settings'],
    ] as const) {
      server(signedIn());
      mount(from);
      await waitFor(() => expect(location()).toBe(to));
      cleanup();
    }
    server(signedIn(MEMBER));
    mount('/access');
    await waitFor(() => expect(location()).toBe('/me/machines'));
  });

  it('titles My machines in a member\'s compact header', async () => {
    screenWidth(390);
    server({ ...signedIn(MEMBER), '/api/members': () => Response.json({ members: [] }), '/api/credentials': () => Response.json({ rows: [], cursor: null }) });
    mount('/me/machines');
    await waitFor(() => expect(screen.getByRole('banner').textContent).toContain('My machines'));
  });

  it('hides every admin page from a member: no Project settings, People & machines, Settings or Health', async () => {
    server(signedIn(MEMBER));
    mount('/p/alpha');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Today', 'Sessions', 'Knowledge', 'Agent runs']);
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    for (const name of ['Project settings', INVITE_CONTROLS.page, 'Settings', 'Health']) expect(within(nav).queryByRole('link', { name })).toBeNull();
  });

  it('keeps the last project in the page links on a page that spans the server, and marks none of the filter picked', async () => {
    server(signedIn());
    window.localStorage.setItem('myco-last-project', 'beta');
    mount('/settings');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('link', { name: 'Agent runs' }).getAttribute('href')).toBe('/p/beta/runs');
    // A page with a form across every project leads there while the path names no project.
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('href')).toBe('/sessions');
    expect(within(pages).getByRole('link', { name: 'Knowledge' }).getAttribute('href')).toBe('/knowledge');
    expect([...pages.querySelectorAll('a[aria-current="page"]')]).toEqual([]);
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    expect(filterItems().filter((a) => a.getAttribute('aria-current') === 'true')).toEqual([]);
    expect(filterItems()[1]!.getAttribute('href')).toBe('/p/beta');
  });
});

describe('the project filter', () => {
  it('narrows the page to a picked project, keeping the list filters and dropping the open record', async () => {
    server(signedIn());
    mount('/p/alpha/sessions?q=fix&state=ended&tab=plans&offset=25');
    await waitFor(() => expect(filterItems()).toHaveLength(2));
    fireEvent.click(filterItems()[1]!);
    await waitFor(() => expect(location()).toBe('/p/beta/sessions?q=fix&state=ended'));
    expect(filterItems()[1]!.getAttribute('aria-current')).toBe('true');
    await waitFor(() => expect(window.localStorage.getItem('myco-last-project')).toBe('beta'));
    // Sessions has a form across every project, so picking the picked project again clears the filter to it, the list filters kept.
    expect(filterItems()[1]!.querySelector('[data-clear-filter]')).not.toBeNull();
    fireEvent.click(filterItems()[1]!);
    await waitFor(() => expect(location()).toBe('/sessions?q=fix&state=ended'));
  });

  it('offers the clear on a page with an all-projects form, and leads it there with the list filters', () => {
    const items = PROJECTS.map((p, i) => ({ ...p, href: `/p/${p.projectId}/sessions`, active: i === 0 }));
    const clearTo = clearProjectHref({ pathname: '/p/alpha/sessions/s1', search: '?q=fix&tab=plans' }, { '/sessions': '/sessions' });
    expect(clearTo).toBe('/sessions?q=fix');
    render(<MemoryRouter><ProjectFilter items={items} clearHref={clearTo} allHref="/projects" now={NOW} /></MemoryRouter>);
    const active = screen.getAllByRole('link').find((a) => a.getAttribute('aria-current') === 'true')!;
    expect(active.getAttribute('href')).toBe('/sessions?q=fix');
    expect(active.querySelector('[data-clear-filter]')).not.toBeNull();
    expect(within(active).getByText('Clear the filter')).toBeTruthy();
    cleanup();
    render(<MemoryRouter><ProjectFilter items={items} clearHref={null} allHref="/projects" now={NOW} /></MemoryRouter>);
    const kept = screen.getAllByRole('link').find((a) => a.getAttribute('aria-current') === 'true')!;
    expect(kept.getAttribute('href')).toBe('/p/alpha/sessions');
    expect(kept.querySelector('[data-clear-filter]')).toBeNull();
  });

  it('works out every link from the path and the query string', () => {
    expect([projectOf('/p/a%2Fb/sessions/s1'), projectOf('/settings'), pageSuffix('/p/x'), pageSuffix('/p/x/runs/r1')]).toEqual(['a/b', null, '', '/runs']);
    expect(keptFilters('?tab=plans&q=fix&turn=t1&state=open&offset=25&type=gotcha')).toBe('?q=fix&state=open&type=gotcha');
    expect(keptFilters('?tab=plans')).toBe('');
    // From a record, a switch leads to the list the record belongs to, filters kept.
    expect(switchProjectHref({ pathname: '/p/x/spores/sp1', search: '?status=all&q=cache' }, 'y')).toBe('/p/y/knowledge?status=all&q=cache');
    expect(switchProjectHref({ pathname: '/p/x/plans/k1', search: '?session=s1' }, 'y')).toBe('/p/y/knowledge/plans');
    expect(switchProjectHref({ pathname: '/knowledge/plans', search: '?q=cache' }, 'y')).toBe('/p/y/knowledge/plans?q=cache');
    expect(switchProjectHref({ pathname: '/p/x', search: '' }, 'a/b')).toBe('/p/a%2Fb');
    expect(switchProjectHref({ pathname: '/settings', search: '?tab=secrets' }, 'y')).toBe('/p/y');
    expect(clearProjectHref({ pathname: '/p/x/sessions', search: '?q=fix' })).toBe('/sessions?q=fix');
    expect(clearProjectHref({ pathname: '/p/x/knowledge/plans', search: '?q=fix' })).toBe('/knowledge/plans?q=fix');
    expect(clearProjectHref({ pathname: '/p/x/spores/sp1', search: '' })).toBe('/knowledge');
    expect(clearProjectHref({ pathname: '/p/x/knowledge/map', search: '' })).toBeNull();
    expect(clearProjectHref({ pathname: '/p/x/runs', search: '?q=fix' })).toBeNull();
    expect(clearProjectHref({ pathname: '/settings', search: '' }, { '/sessions': '/sessions' })).toBeNull();
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
    mount('/settings');
    await waitFor(() => expect(filterItems()).toHaveLength(8));
    const more = within(screen.getByRole('navigation', { name: 'Projects' })).getByRole('link', { name: '3 more' });
    expect(more.getAttribute('href')).toBe('/projects');
  });
});

describe('the page titles', () => {
  it('names every page under a project and every server page, and says not found for the rest', () => {
    expect([
      titleOf('/p/x'), titleOf('/p/x/'), titleOf('/p/x/sessions'), titleOf('/p/x/sessions/abc'), titleOf('/p/x/plans/k1'),
      titleOf('/p/x/knowledge'), titleOf('/p/x/spores/sp1'), titleOf('/p/x/runs/r1'), titleOf('/p/x/settings'), titleOf('/p/x/nope'),
      titleOf('/'), titleOf('/projects'), titleOf('/status/health'), titleOf('/people'), titleOf('/me/machines'), titleOf('/settings'), titleOf('/settings/models'), titleOf('/nope'),
      titleOf('/knowledge'), titleOf('/knowledge/plans'),
    ]).toEqual([
      'Today', 'Today', 'Sessions', 'Sessions', 'Knowledge',
      'Knowledge', 'Knowledge', 'Agent runs', 'Project settings', 'Not found',
      'Today', 'Projects', 'Health', INVITE_CONTROLS.page, 'My machines', 'Settings', 'Settings', 'Not found',
      'Knowledge', 'Knowledge',
    ]);
    // A page whose suffix runs over two segments is found whole, and a project switch keeps it.
    expect([pageSuffix('/p/x/knowledge/map'), pageSuffix('/p/x/knowledge/map/'), titleOf('/p/x/knowledge/map'), pageSuffix('/p/x/knowledge'), pageSuffix('/p/x/knowledge/plans')])
      .toEqual(['/knowledge/map', '/knowledge/map', 'Knowledge', '/knowledge', '/knowledge/plans']);
    expect(switchProjectHref({ pathname: '/p/x/knowledge/map', search: '' }, 'y')).toBe('/p/y/knowledge/map');
  });
});

describe('on a phone', () => {
  it('puts the main pages on a bottom bar, the page title in the header, and the rest of the nav behind More', async () => {
    screenWidth(390);
    server(signedIn());
    mount('/p/alpha/sessions');
    const bar = await screen.findByRole('navigation', { name: 'Main pages' });
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Today', 'Sessions', 'Knowledge']);
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
    fireEvent.click(within(within(drawer).getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Knowledge' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull());
    expect(location()).toBe('/p/alpha/knowledge');
  });

  it('keeps Tab inside the open drawer, and returns focus to the button that opened it', async () => {
    screenWidth(390);
    server(signedIn());
    mount('/p/alpha/sessions');
    const more = within(await screen.findByRole('navigation', { name: 'Main pages' })).getByRole('button', { name: 'More' });
    expect(more.getAttribute('aria-haspopup')).toBe('dialog');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.focus();
    fireEvent.click(more);
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    expect(more.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(filterItems().length).toBeGreaterThan(0));
    const tabbable = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const first = tabbable[0]!;
    const last = tabbable.at(-1)!;
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    const focused = () => describeFocus(document.activeElement);
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(focused()).toBe(describeFocus(first));
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(focused()).toBe(describeFocus(last));
    // Focus sent outside the drawer is pulled back in, and the page behind it is hidden from assistive technology.
    const behind = document.getElementById('main')!;
    behind.focus();
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(behind.closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull());
    await waitFor(() => expect(focused()).toBe(describeFocus(more)));
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the nav from a menu button on a tablet, where there is no bottom bar', async () => {
    screenWidth(800);
    server(signedIn());
    mount('/p/alpha');
    const opener = await screen.findByRole('button', { name: 'Open navigation' });
    expect([opener.getAttribute('aria-haspopup'), opener.getAttribute('aria-expanded')]).toEqual(['dialog', 'false']);
    fireEvent.click(opener);
    expect(await screen.findByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
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
    // The menu stays open, so mode, accent and density are set in one visit.
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Compact' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Terracotta' }));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('myco-appearance')!)).toMatchObject({ mode: 'light', density: 'compact', theme: 'terracotta' });
    document.documentElement.removeAttribute('data-density');
    document.documentElement.setAttribute('data-theme', 'sage');
    document.documentElement.classList.remove('light');
    window.localStorage.removeItem('myco-appearance');
  });
});

describe('/notifications', () => {
  it('redirects to the start, which is Today across every project', async () => {
    server(signedIn());
    mount('/notifications');
    await waitFor(() => expect(location()).toBe('/'));
    expect(await screen.findByRole('heading', { level: 1 })).toBeTruthy();
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
