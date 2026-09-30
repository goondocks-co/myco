/**
 * The plans page: a Project's plans as one list, and the status written through
 * the one route that owns it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { planPath } from '../../packages/myco-server/ui/src/hooks/use-plans';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris', role: 'admin' as const } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 1, lastActivityAt: null, archivedAt: null, archivedBy: null }] };
const NOW = Date.now();

const plan = (over: Record<string, unknown> = {}) => ({
  planKey: '11111111-2222-4333-8444-555555555555', sessionId: 'sess_1', promptId: null, title: 'Rebuild the cache',
  status: 'in_progress', content: '- [x] measure it\n- [ ] fix it', blobKey: null, originPath: 'docs/plan.md',
  progress: '1/2', updatedBy: null, createdAt: NOW - 60_000, updatedAt: NOW, tags: ['cache'], ...over,
});

interface Sent { method: string; path: string; body: unknown }
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, () => Response>): { requested: string[]; sent: Sent[] } {
  const requested: string[] = [];
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    if ((init?.method ?? 'GET') !== 'GET') sent.push({ method: init!.method!, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes[url.pathname + url.search]?.() ?? routes[url.pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested, sent };
}

const base = (extra: Record<string, () => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json({ members: [{ id: 'mem_1', label: 'chris', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 }] }),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('the plans page', () => {
  it('lists a project\'s plans with their progress and the session each came from', async () => {
    server(base({ '/api/projects/x/plans?limit=100': () => Response.json({ plans: [plan()], maxPage: 200 }) }));
    mount('/p/x/plans');
    const list = await screen.findByLabelText('Plans');
    expect(within(list).getByText('Rebuild the cache')).toBeTruthy();
    expect(within(list).getByText('1/2 items')).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Open its session' }).getAttribute('href')).toBe('/p/x/sessions/sess_1');
  });

  it('reads the list a page at a time and loads the next page on request, keeping the filter across a refetch', async () => {
    const first = Array.from({ length: 3 }, (_, i) => plan({ planKey: `p-${i}`, title: `Plan ${i}` }));
    const { requested } = server(base({
      '/api/projects/x/plans?limit=100&status=in_progress': () => Response.json({ plans: first, cursor: `${NOW}:p-2`, maxPage: 200 }),
      [`/api/projects/x/plans?limit=100&status=in_progress&cursor=${encodeURIComponent(`${NOW}:p-2`)}`]: () => Response.json({ plans: [plan({ planKey: 'p-3', title: 'Plan 3' })], cursor: null, maxPage: 200 }),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/p/x/plans?status=in_progress']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
    const list = await screen.findByLabelText('Plans');
    expect(within(list).getAllByRole('listitem').length).toBe(3);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(screen.getByLabelText('Plans')).getAllByRole('listitem').length).toBe(4));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // A refetch re-reads the pages it holds under the same filter, and leaves the filter where it was.
    await client.refetchQueries({ queryKey: ['project-plans', 'x'] });
    expect(within(screen.getByLabelText('Plans')).getAllByRole('listitem').length).toBe(4);
    expect(screen.getByRole('tab', { name: 'In progress', selected: true })).toBeTruthy();
    expect(requested.filter((r) => r.startsWith('/api/projects/x/plans')).every((r) => r.includes('status=in_progress'))).toBe(true);
  });

  it('shows a project with no plans as empty, not as missing', async () => {
    server(base({ '/api/projects/x/plans?limit=100': () => Response.json({ plans: [], maxPage: 200 }) }));
    mount('/p/x/plans');
    expect(await screen.findByText(/No plans yet/)).toBeTruthy();
  });

  it('puts the status filter in the URL and asks the server for that status alone', async () => {
    const { requested } = server(base({
      '/api/projects/x/plans?limit=100': () => Response.json({ plans: [plan()], maxPage: 200 }),
      '/api/projects/x/plans?limit=100&status=completed': () => Response.json({ plans: [], maxPage: 200 }),
    }));
    mount('/p/x/plans');
    await screen.findByLabelText('Plans');
    fireEvent.click(screen.getByRole('tab', { name: 'Completed' }));
    await waitFor(() => expect(requested).toContain('/api/projects/x/plans?limit=100&status=completed'));
    expect(await screen.findByText('No completed plans.')).toBeTruthy();
  });

  it('writes a status change through the session route that owns a plan\'s status', async () => {
    const key = plan().planKey;
    const { sent } = server(base({
      '/api/projects/x/plans?limit=100': () => Response.json({ plans: [plan()], maxPage: 200 }),
      [`/api/projects/x/sessions/sess_1/plans/${key}/status`]: () => Response.json({ plan: plan({ status: 'completed' }) }),
    }));
    mount('/p/x/plans');
    const control = await screen.findByLabelText('Status of Rebuild the cache');
    fireEvent.change(control, { target: { value: 'completed' } });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ method: 'POST', path: `/api/projects/x/sessions/sess_1/plans/${key}/status`, body: { status: 'completed' } });
  });

  it('says the plans could not be read rather than showing an empty project', async () => {
    server(base({ '/api/projects/x/plans?limit=100': () => new Response(null, { status: 503 }) }));
    mount('/p/x/plans');
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
  });

  it('keeps Plans the active section while the page is open', async () => {
    server(base({ '/api/projects/x/plans?limit=100': () => Response.json({ plans: [], maxPage: 200 }) }));
    mount('/p/x/plans');
    await screen.findByText(/No plans yet/);
    const nav = screen.getByRole('navigation', { name: 'Pages' });
    expect([...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Plans']);
  });
});

describe('a plan\'s own link', () => {
  it('opens one plan at its own session rather than at the whole list', () => {
    expect(planPath('a/b', plan({ planKey: 'p&1', sessionId: 's 1' })))
      .toBe('/p/a%2Fb/sessions/s%201?tab=plans&plan=p%261');
  });
});

describe('a plan card anywhere', () => {
  it('links back to the turn that wrote it by naming the session path, not by riding the current one', async () => {
    server(base({ '/api/projects/x/plans?limit=100': () => Response.json({ plans: [plan({ promptId: 'turn_9' })], maxPage: 200 }) }));
    mount('/p/x/plans');
    const list = await screen.findByLabelText('Plans');
    // On /p/x/plans a relative `?turn=` would resolve against a page that reads no
    // turn, so the link has to carry the session it belongs to.
    expect(within(list).getByRole('link', { name: 'From its turn' }).getAttribute('href'))
      .toBe('/p/x/sessions/sess_1?turn=turn_9');
  });
});
