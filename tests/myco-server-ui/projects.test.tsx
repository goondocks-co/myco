import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
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
  '/api/projects': () => Response.json({ projects }),
  '/api/projects/live/activity': () => Response.json(EMPTY_ACTIVITY),
  '/api/projects/arch/activity': () => Response.json(EMPTY_ACTIVITY),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Projects', () => {
  it('hides an archived project by default and shows it on request, with who archived it', async () => {
    server(base([LIVE, ARCH]));
    mount('/projects');
    const list = await screen.findByRole('list', { name: 'Projects' });
    expect(within(list).getByText('Live')).toBeTruthy();
    expect(screen.queryByText('Arch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }));
    const archived = await screen.findByRole('region', { name: 'Archived projects' });
    expect(within(archived).getByText('Arch')).toBeTruthy();
    expect(within(archived).getByText(/Archived .* by mem_1/)).toBeTruthy();
    expect(within(archived).getByRole('button', { name: 'Unarchive' })).toBeTruthy();
  });

  it('asks before archiving, names the consequence, and posts the archive', async () => {
    const { posts } = server(base([LIVE], { '/api/projects/live/archive': () => Response.json({ archived: true, archivedBy: 'mem_1' }) }));
    mount('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Archive Live?')).toBeTruthy();
    expect(screen.getByText(/Capture from every runtime stops until you unarchive/)).toBeTruthy();
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
  it('shows the archived banner with Unarchive, and keeps the project selectable', async () => {
    server(base([LIVE, ARCH]));
    mount('/p/arch');
    expect(await screen.findByTestId('archived-banner')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unarchive' })).toBeTruthy();
    const switcher = screen.getByRole('button', { name: 'Project' });
    expect(switcher.textContent).toContain('Archived');
    fireEvent.click(switcher);
    const options = within(screen.getByRole('listbox', { name: 'Projects' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Live'), expect.stringContaining('Archived')]);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps an archived project out of the switcher on a live project\'s pages, and switching keeps the page', async () => {
    server(base([LIVE, ARCH]));
    mount('/p/live/sessions');
    fireEvent.click(await screen.findByRole('button', { name: 'Project' }));
    const options = within(screen.getByRole('listbox', { name: 'Projects' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining('Live')]);
    expect(screen.queryByTestId('archived-banner')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toContain('Sessions');
  });

  it('renames a project from its card, sending the typed name, and shows the new name once the list refreshes', async () => {
    let name = 'Live';
    const { patches } = server(base([], {
      '/api/projects': () => Response.json({ projects: [{ ...LIVE, name }] }),
      '/api/projects/live': (init) => { name = (JSON.parse(String(init?.body)) as { name: string }).name; return Response.json({ projectId: 'live', name }); },
    }));
    mount('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('Name') as HTMLInputElement;
    expect(input.value).toBe('Live');
    fireEvent.change(input, { target: { value: '  Myco  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Myco')).toBeTruthy();
    expect(patches).toEqual([{ path: '/api/projects/live', body: { name: 'Myco' } }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
