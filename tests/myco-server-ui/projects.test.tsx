import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris', role: 'admin' as const } };
const NOW = Date.now();
const LIVE = { projectId: 'live', name: 'Live', createdAt: 0, sessionCount: 3, lastActivityAt: NOW, archivedAt: null, archivedBy: null };
const ARCH = { projectId: 'arch', name: 'Arch', createdAt: 0, sessionCount: 1, lastActivityAt: NOW - 1000, archivedAt: NOW - 500, archivedBy: 'mem_1' };
const EMPTY_ACTIVITY = { items: [], stats: { sessions: 0, openSessions: 0, sessionsLast7d: 0, prompts: 0, toolCalls: 0, plans: 0, attachments: 0, lastActivityAt: null } };

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { posts: string[]; patches: Array<{ path: string; body: unknown }> } {
  const posts: string[] = [];
  const patches: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const pathname = new URL(href, 'https://s').pathname;
    if (init?.method === 'POST') posts.push(pathname);
    if (init?.method === 'PATCH') patches.push({ path: pathname, body: JSON.parse(String(init.body)) });
    return routes[pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { posts, patches };
}

const base = (projects: unknown[], extra: Record<string, (init?: RequestInit) => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/members': () => Response.json({ members: [{ id: 'mem_1', label: 'chris', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 }] }),
  '/api/projects': () => Response.json({ projects }),
  '/api/projects/live/activity': () => Response.json(EMPTY_ACTIVITY),
  '/api/projects/arch/activity': () => Response.json(EMPTY_ACTIVITY),
  ...extra,
});

/** Opens a project's menu, the way a keyboard does. */
async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole('button', { name: `Actions for ${name}` }), { key: 'Enter' });
  return screen.findByRole('menu');
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Projects', () => {
  it('says it is loading while the list is unread, never that there are no projects', async () => {
    // The list never answers: the page shows its loading rows, and neither the empty state nor the setup command.
    server(base([], { '/api/projects': () => new Promise<Response>(() => undefined) as unknown as Response }));
    mount('/projects');
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeTruthy();
    expect(await screen.findByRole('status', { name: 'Loading projects' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect({ empty: screen.queryByText('No projects yet.') !== null, setup: screen.queryByText('myco setup') !== null }).toEqual({ empty: false, setup: false });
  });

  it('hides an archived project by default and shows it on request, with who archived it', async () => {
    server(base([LIVE, ARCH]));
    mount('/projects');
    const list = await screen.findByRole('list', { name: 'Projects' });
    expect(within(list).getByText('Live')).toBeTruthy();
    expect(screen.queryByText('Arch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    const archived = await screen.findByRole('region', { name: 'Archived projects' });
    expect(within(archived).getByText('Arch')).toBeTruthy();
    // Who archived it reads as their name, never their id.
    expect(await within(archived).findByText(/Archived .* by chris/)).toBeTruthy();
    expect(archived.textContent).not.toContain('mem_1');
    expect(within(archived).getByRole('button', { name: 'Unarchive' })).toBeTruthy();
  });

  it('asks before archiving, names the consequence, and posts the archive', async () => {
    const { posts } = server(base([LIVE], { '/api/projects/live/archive': () => Response.json({ archived: true, archivedBy: 'mem_1' }) }));
    mount('/projects');
    fireEvent.click(within(await openMenu('Live')).getByRole('menuitem', { name: 'Archive' }));
    expect(await screen.findByText('Archive Live?')).toBeTruthy();
    expect(screen.getByText(/Capture from every agent stops until you unarchive/)).toBeTruthy();
    expect(posts).toEqual([]);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Archive' }));
    await screen.findByRole('list', { name: 'Projects' });
    expect(posts).toEqual(['/api/projects/live/archive']);
  });

  it('says the refusal in the person\'s words', async () => {
    server(base([LIVE, ARCH], { '/api/projects/arch/unarchive': () => Response.json({ error: 'not_archived' }, { status: 409 }) }));
    mount('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unarchive' }));
    expect(await screen.findByText('Not archived.')).toBeTruthy();
  });
});

describe('an archived project\'s home and navigation', () => {
  it('shows the archived banner with Unarchive, and keeps the open archived project in the scope switcher', async () => {
    server(base([LIVE, ARCH]));
    mount('/p/arch');
    expect(await screen.findByTestId('archived-banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Showing: Arch' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu', { name: /^Showing: / });
    const items = [...menu.querySelectorAll('[data-scope-option="project"]')];
    expect(items.map((a) => a.textContent)).toEqual([expect.stringContaining('Live'), expect.stringContaining('Arch')]);
    expect(items[1]!.getAttribute('aria-current')).toBe('true');
  });

  it('keeps an archived project out of the scope switcher on a live project\'s pages, and picking another project keeps the page and remembers the pick', async () => {
    const OTHER = { projectId: 'other', name: 'Other', createdAt: 0, sessionCount: 0, lastActivityAt: NOW - 5000, archivedAt: null, archivedBy: null };
    server(base([LIVE, ARCH, OTHER], {
      '/api/sessions': () => Response.json({ rows: [], cursor: null }),
    }));
    mount('/p/live/sessions');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Showing: Live' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu', { name: /^Showing: / });
    const items = [...menu.querySelectorAll<HTMLElement>('[data-scope-option="project"]')];
    expect(items.map((a) => a.textContent)).toEqual([expect.stringContaining('Live'), expect.stringContaining('Other')]);
    expect(screen.queryByTestId('archived-banner')).toBeNull();
    fireEvent.click(items[1]!);
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    await waitFor(() => expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('aria-current')).toBe('page'));
    expect(within(pages).getByRole('link', { name: 'Sessions' }).getAttribute('href')).toBe('/p/other/sessions');
    await waitFor(() => expect(localStorage.getItem('myco-last-project')).toBe('other'));
  });

  it('renames a project from its card, sending the typed name, and shows the new name once the list refreshes', async () => {
    let name = 'Live';
    const { patches } = server(base([], {
      '/api/projects': () => Response.json({ projects: [{ ...LIVE, name }] }),
      '/api/projects/live': (init) => { name = (JSON.parse(String(init?.body)) as { name: string }).name; return Response.json({ projectId: 'live', name }); },
    }));
    mount('/projects');
    fireEvent.click(within(await openMenu('Live')).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(input.value).toBe('Live');
    fireEvent.change(input, { target: { value: '  Myco  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(await screen.findByRole('list', { name: 'Projects' })).findByText('Myco')).toBeTruthy();
    expect(patches).toEqual([{ path: '/api/projects/live', body: { name: 'Myco' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a project\'s menu', () => {
  it('leads an admin to the project\'s settings, and offers a member no menu', async () => {
    server(base([LIVE]));
    mount('/projects');
    fireEvent.click(within(await openMenu('Live')).getByRole('menuitem', { name: 'Project settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Project settings' })).toBeTruthy();
    cleanup();
    server({ ...base([LIVE]), '/auth/me': () => Response.json({ ...ME, member: { ...ME.member, role: 'member' } }) });
    mount('/projects');
    await screen.findByRole('list', { name: 'Projects' });
    expect(screen.queryByRole('button', { name: 'Actions for Live' })).toBeNull();
  });
});
