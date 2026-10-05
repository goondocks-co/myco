import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { recencyOf } from '../../packages/myco-server/ui/src/design';
import { scopeAll } from '../../packages/myco-server/ui/src/routes/scope';
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
/** The page's scope switcher, once it renders. */
const findScope = () => screen.findByRole('button', { name: /^Showing: / });
/** Opens the page's scope switcher and answers its list. */
async function openScope(): Promise<HTMLElement> {
  fireEvent.keyDown(await findScope(), { key: 'Enter' });
  return screen.findByRole('menu', { name: /^Showing: / });
}
const scopeOptions = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[data-scope-option]')];

describe('the dashboard shell', () => {
  it('hands a member with no projects to myco setup', async () => {
    server({ '/auth/me': me(), '/api/projects': () => Response.json({ projects: [] }) });
    mount('/projects');
    expect(await within(await screen.findByRole('main')).findByText('No projects yet.')).toBeTruthy();
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
  it('shows an admin the pages, the admin foot, search and the account, and no list of projects', async () => {
    server(signedIn());
    mount('/p/alpha/sessions');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Today', 'Sessions', 'Knowledge', 'Myco’s work', 'Project settings']);
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page');
    expect(within(pages).getByRole('link', { name: 'Project settings' }).getAttribute('href')).toBe('/p/alpha/settings');
    await findScope();
    // Which projects a page shows is said in its header; the nav lists pages only.
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    expect(within(nav).queryByRole('navigation', { name: 'Projects' })).toBeNull();
    expect(nav.querySelector('[data-scope-switcher]')).toBeNull();
    expect(nav.textContent).not.toContain('Beta');
    expect(nav.textContent).not.toContain('All projects');
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
    expect(await within(admin).findByRole('link', { name: 'Health, 2 things need you' })).toBeTruthy();
    cleanup();
    server({ ...signedIn(), '/api/attention': () => Response.json({ items: [], unavailable: [] }) });
    mount('/p/alpha/sessions');
    const quiet = await screen.findByRole('navigation', { name: 'Admin' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(quiet).getByRole('link', { name: 'Health' })).toBeTruthy();
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
    server({ ...signedIn(MEMBER), '/api/members': () => Response.json({ members: [] }), '/api/credentials': () => Response.json({ rows: [], cursor: null }), '/api/machines': () => Response.json({ machines: [], cursor: null }) });
    mount('/me/machines');
    // The shell's own header: the page's header renders beside it at once, and jsdom reads that as a banner too.
    await waitFor(() => expect(document.querySelector('header[data-shell]')?.textContent).toContain('My machines'));
  });

  it('hides every admin page from a member: no Project settings, People & machines, Settings or Health', async () => {
    server(signedIn(MEMBER));
    mount('/p/alpha');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.textContent)).toEqual(['Today', 'Sessions', 'Knowledge', 'Myco’s work']);
    await findScope();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    const nav = screen.getByRole('complementary', { name: 'Navigation' });
    for (const name of ['Project settings', INVITE_CONTROLS.page, 'Settings', 'Health']) expect(within(nav).queryByRole('link', { name })).toBeNull();
  });

  it('keeps the last project in the page links on a page that spans the server', async () => {
    server(signedIn());
    window.localStorage.setItem('myco-last-project', 'beta');
    mount('/settings');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    // A page with a form across every project leads there while the path names no project.
    expect(within(pages).getByRole('link', { name: 'Myco’s work' }).getAttribute('href')).toBe('/work');
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('href')).toBe('/sessions');
    expect(within(pages).getByRole('link', { name: 'Knowledge' }).getAttribute('href')).toBe('/knowledge');
    expect([...pages.querySelectorAll('a[aria-current="page"]')]).toEqual([]);
    expect(within(pages).getByRole('link', { name: 'Today' }).getAttribute('href')).toBe('/');
  });
});

describe('the scope switcher', () => {
  /** The page header holding the title. */
  const header = () => document.querySelector('main h1')!.parentElement!.parentElement as HTMLElement;
  /** The header's own words, the switcher's left out. */
  const headerWords = () => {
    const copy = header().cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-scope-switcher]').forEach((node) => node.remove());
    return copy.textContent ?? '';
  };
  const scoped: ReadonlyArray<readonly [string, string]> = [
    ['/', 'All projects'], ['/p/alpha', 'Alpha'],
    ['/sessions', 'All projects'], ['/p/alpha/sessions', 'Alpha'],
    ['/knowledge', 'All projects'], ['/p/alpha/knowledge', 'Alpha'],
    ['/knowledge/plans', 'All projects'], ['/p/beta/knowledge/plans', 'Beta'], ['/p/alpha/knowledge/map', 'Alpha'],
    ['/work', 'All projects'], ['/p/alpha/work', 'Alpha'],
    ['/work/tasks', 'All projects'], ['/p/beta/work/tasks', 'Beta'],
    ['/p/alpha/settings', 'Alpha'],
  ];

  it('says the scope in plain words beside the title of every page that has one, and the subtitle never says another', async () => {
    for (const [path, words] of scoped) {
      server(signedIn());
      mount(path);
      const scope = await findScope();
      await waitFor(() => expect({ path, words: scope.querySelector('[data-scope-current]')!.textContent }).toEqual({ path, words }));
      expect(scope.getAttribute('data-scope-switcher')).toBe(words === 'All projects' ? 'all' : 'project');
      // The switcher sits in the page's header, beside its title.
      expect(scope.parentElement!.querySelector('h1')).not.toBeNull();
      const said = headerWords();
      if (words === 'All projects') for (const name of ['Alpha', 'Beta']) expect({ path, said: said.includes(name) }).toEqual({ path, said: false });
      else {
        expect({ path, said: /every project|all projects|across/i.test(said) }).toEqual({ path, said: false });
        expect({ path, said: said.includes(words === 'Alpha' ? 'Beta' : 'Alpha') }).toEqual({ path, said: false });
      }
      cleanup();
    }
  });

  it('lists All projects first, then every project with its session count and recency, and a way to every project in detail', async () => {
    server(signedIn());
    mount('/p/alpha/sessions');
    const menu = await openScope();
    expect(scopeOptions(menu).map((option) => [option.getAttribute('data-scope-option'), option.textContent])).toEqual([
      ['all', 'All projects'], ['project', expect.stringContaining('Alpha')], ['project', expect.stringContaining('Beta')],
    ]);
    const [, alpha, beta] = scopeOptions(menu);
    // Each is a radio choice: the scope now is the checked one.
    expect(scopeOptions(menu).map((option) => [option.getAttribute('role'), option.getAttribute('aria-checked')])).toEqual([['menuitemradio', 'false'], ['menuitemradio', 'true'], ['menuitemradio', 'false']]);
    expect(alpha!.getAttribute('aria-checked')).toBe('true');
    expect(beta!.textContent).toContain('194');
    // Each row reads as its name, its session count and its recency in words: the dot is never the only telling.
    expect(within(beta!).getByText(', 194 sessions, no activity today').className).toContain('sr-only');
    expect(within(alpha!).getByText(', 681 sessions, active in the last hour').className).toContain('sr-only');
    // Nothing in the list is a scroll region Tab would have to reach, which a menu never moves to: arrow keys reach every row.
    expect(menu.querySelector('[data-scope-projects]')).toBeNull();
    expect([menu, ...menu.querySelectorAll<HTMLElement>('*')].some((node) => /overflow-y-(auto|scroll)/.test(node.className))).toBe(false);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Every project, in detail' }));
    await waitFor(() => expect(location()).toBe('/projects'));
  });

  it('keeps the section and the list filters when it switches, between projects and to All projects', async () => {
    server(signedIn());
    mount('/p/alpha/sessions?q=fix&state=ended&tab=plans&offset=25');
    fireEvent.click(scopeOptions(await openScope())[2]!);
    await waitFor(() => expect(location()).toBe('/p/beta/sessions?q=fix&state=ended'));
    await waitFor(() => expect(window.localStorage.getItem('myco-last-project')).toBe('beta'));
    await waitFor(() => expect((document.querySelector('[data-scope-current]') as HTMLElement).textContent).toBe('Beta'));
    fireEvent.click(scopeOptions(await openScope())[0]!);
    await waitFor(() => expect(location()).toBe('/sessions?q=fix&state=ended'));
    for (const [from, pick, to] of [
      ['/work/tasks', 1, '/p/alpha/work/tasks'], ['/knowledge/plans?q=cache', 2, '/p/beta/knowledge/plans?q=cache'], ['/', 1, '/p/alpha'], ['/p/alpha/work', 0, '/work'],
    ] as const) {
      cleanup();
      server(signedIn());
      mount(from);
      fireEvent.click(scopeOptions(await openScope())[pick]!);
      await waitFor(() => expect({ from, at: location() }).toEqual({ from, at: to }));
    }
  });

  it('offers only projects on a page drawn per project, and says why', async () => {
    server(signedIn());
    mount('/p/alpha/knowledge/map');
    const menu = await openScope();
    expect(scopeOptions(menu).map((option) => option.getAttribute('data-scope-option'))).toEqual(['project', 'project']);
    const reason = menu.querySelector('[data-scope-all-reason]')!;
    expect(reason.textContent).toBe('The code map is drawn for one project at a time.');
    // The reason is the list's description, so it is announced with it.
    expect(menu.getAttribute('aria-describedby')).toBe(reason.id);
    expect(scopeAll({ pathname: '/p/alpha/settings', search: '' })).toEqual({ reason: 'These settings belong to one project.' });
    // From a record, "All projects" leads to its list across every project, and says it leaves the record.
    for (const [pathname, href] of [['/p/alpha/sessions/s1', '/sessions'], ['/p/alpha/spores/sp1', '/knowledge'], ['/p/alpha/plans/k1', '/knowledge/plans'], ['/p/alpha/work/runs/r1', '/work']] as const) {
      expect({ pathname, all: scopeAll({ pathname, search: '' }) }).toEqual({ pathname, all: { href, active: false, leaves: 'Leaves this page for the list across every project.' } });
    }
    expect(scopeAll({ pathname: '/p/alpha/sessions', search: '?q=fix&tab=x' })).toEqual({ href: '/sessions?q=fix', active: false });
    expect(scopeAll({ pathname: '/work/tasks', search: '' })).toEqual({ href: '/work/tasks', active: true });
    expect(scopeAll({ pathname: '/settings', search: '' })).toBeNull();
  });

  it('shows six projects at a time, the scope kept on the first page, and every other a page away, never a scroll', async () => {
    const many = Array.from({ length: 14 }, (_, i) => project(`p${i}`, `Project ${String(i).padStart(2, '0')}`, i, NOW - i * 60_000));
    server({ ...signedIn(), '/api/projects': () => Response.json({ projects: many }) });
    mount('/p/p11/sessions');
    let menu = await openScope();
    const names = () => scopeOptions(menu).filter((option) => option.getAttribute('data-scope-option') === 'project').map((option) => option.textContent!.slice(0, 10));
    expect(names()).toEqual(['Project 00', 'Project 01', 'Project 02', 'Project 03', 'Project 04', 'Project 11']);
    const more = within(menu).getByRole('menuitem', { name: 'More projects (8 more)' });
    fireEvent.click(more);
    menu = await screen.findByRole('menu', { name: /^Showing: / });
    await waitFor(() => expect(names()).toEqual(['Project 05', 'Project 06', 'Project 07', 'Project 08', 'Project 09', 'Project 10']));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'More projects (2 more)' }));
    await waitFor(() => expect(names()).toEqual(['Project 12', 'Project 13']));
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Back to the most recent' }));
    await waitFor(() => expect(names()[0]).toBe('Project 00'));
    fireEvent.click(scopeOptions(menu).find((option) => option.textContent!.startsWith('Project 02'))!);
    await waitFor(() => expect(location()).toBe('/p/p2/sessions'));
  });

  it('shows no switcher on a page for the whole server, and says it applies to every project', async () => {
    for (const path of ['/settings', '/status/health', '/people', '/me/machines']) {
      server({ ...signedIn(), '/api/credentials': () => Response.json({ rows: [], cursor: null }), '/api/machines': () => Response.json({ machines: [], cursor: null }) });
      mount(path);
      await waitFor(() => expect({ path, line: document.querySelector('[data-scope-deployment]')?.textContent }).toEqual({ path, line: 'Applies to every project.' }));
      expect(document.querySelector('[data-scope-switcher]')).toBeNull();
      cleanup();
    }
  });

  it('resolves every deep link under a project, saying its project in the switcher', async () => {
    for (const path of ['/p/beta', '/p/beta/sessions', '/p/beta/knowledge/map', '/p/beta/work/tasks', '/p/beta/work/runs/run_1']) {
      server(signedIn());
      mount(path);
      // A run's panel hides the page behind it from assistive technology, so the switcher is found by its mark.
      await waitFor(() => expect({ path, words: document.querySelector('[data-scope-current]')?.textContent }).toEqual({ path, words: 'Beta' }));
      expect(location()).toBe(path);
      expect(screen.queryByRole('heading', { level: 1, name: 'Not found' })).toBeNull();
      cleanup();
    }
  });

  it('works out every link from the path and the query string', () => {
    expect([projectOf('/p/a%2Fb/sessions/s1'), projectOf('/settings'), pageSuffix('/p/x'), pageSuffix('/p/x/work/runs/r1')]).toEqual(['a/b', null, '', '/work/runs']);
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
    // A run leads back to Myco's work: under the project on a switch, across every project on a clear.
    expect(switchProjectHref({ pathname: '/p/x/work/runs/r1', search: '?window=today&outcome=map' }, 'y')).toBe('/p/y/work?window=today&outcome=map');
    expect(clearProjectHref({ pathname: '/p/x/work', search: '?q=fix' })).toBe('/work?q=fix');
    expect(clearProjectHref({ pathname: '/p/x/work/runs/r1', search: '' })).toBe('/work');
    expect(clearProjectHref({ pathname: '/settings', search: '' }, { '/sessions': '/sessions' })).toBeNull();
  });

  it('says recency in words', () => {
    expect([recencyOf(null, NOW).label, recencyOf(NOW - 1000, NOW).label, recencyOf(NOW - 3 * 3_600_000, NOW).label, recencyOf(NOW - 30 * 3_600_000, NOW).label])
      .toEqual(['No sessions yet', 'Active in the last hour', 'Active today', 'No activity today']);
  });
});

describe('the page titles', () => {
  it('names every page under a project and every server page, and says not found for the rest', () => {
    expect([
      titleOf('/p/x'), titleOf('/p/x/'), titleOf('/p/x/sessions'), titleOf('/p/x/sessions/abc'), titleOf('/p/x/plans/k1'),
      titleOf('/p/x/knowledge'), titleOf('/p/x/spores/sp1'), titleOf('/p/x/work/runs/r1'), titleOf('/p/x/settings'), titleOf('/p/x/nope'),
      titleOf('/'), titleOf('/projects'), titleOf('/status/health'), titleOf('/people'), titleOf('/me/machines'), titleOf('/settings'), titleOf('/settings/models'), titleOf('/nope'),
      titleOf('/knowledge'), titleOf('/knowledge/plans'), titleOf('/work'), titleOf('/p/x/work'),
    ]).toEqual([
      'Today', 'Today', 'Sessions', 'Sessions', 'Knowledge',
      'Knowledge', 'Knowledge', 'Myco’s work', 'Project settings', 'Not found',
      'Today', 'Projects', 'Health', INVITE_CONTROLS.page, 'My machines', 'Settings', 'Settings', 'Not found',
      'Knowledge', 'Knowledge', 'Myco’s work', 'Myco’s work',
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
    expect(document.querySelector('header[data-shell]')?.textContent).toContain('Sessions');
    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Admin' })).toBeNull();
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }));
    const drawer = await screen.findByRole('dialog', { name: 'Navigation' });
    expect(within(drawer).getByRole('navigation', { name: 'Admin' })).toBeTruthy();
    expect(within(drawer).queryByRole('navigation', { name: 'Projects' })).toBeNull();
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
    await within(drawer).findByRole('navigation', { name: 'Pages' });
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
