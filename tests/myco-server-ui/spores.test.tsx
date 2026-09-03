import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { sporePreview, sporeTags } from '../../packages/myco-server/ui/src/components/spores/labels';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 1, lastActivityAt: null }] };
const NOW = Date.now();

const spore = (over: Record<string, unknown> = {}) => ({
  id: 'sp1', agentId: 'agent_1', sessionId: 's1', promptId: null, observationType: 'gotcha', status: 'active',
  content: 'The cache lies after a rebase.', context: null, importance: 8, filePath: 'src/cache.ts',
  tags: null, contentHash: null, properties: null, createdAt: NOW - 60_000, updatedAt: null, embedded: 0, ...over,
});
const list = (spores: unknown[], total = spores.length) => Response.json({ spores, total, maxPage: 200 });

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, () => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    return routes[url.pathname + url.search]?.() ?? routes[url.pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

const base = (extra: Record<string, () => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('Spores list', () => {
  const ROWS = [
    spore({ id: 'sp1', observationType: 'gotcha', content: 'The cache lies after a rebase.' }),
    spore({ id: 'sp2', observationType: 'decision', status: 'superseded', content: '# Ship it\n\nWe page by offset.' }),
  ];

  it('opens on what the project holds true, lists each spore by type and preview, and marks the ones no longer active', async () => {
    const { requested } = server(base({ '/api/projects/x/spores?limit=25&status=active': () => list(ROWS) }));
    mount('/p/x/spores');
    const rows = await screen.findAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Gotcha');
    expect(rows[0]!.textContent).toContain('The cache lies after a rebase.');
    expect(rows[1]!.textContent).toContain('Decision');
    expect(rows[1]!.textContent).toContain('Superseded');
    // The markdown heading reads as its text, not its marker.
    expect(rows[1]!.textContent).toContain('Ship it');
    expect(rows[0]!.textContent).not.toContain('Active');
    expect(screen.getByTestId('spore-rail-counts').textContent).toBe('2 TOTAL');
    expect(requested).toContain('/api/projects/x/spores?limit=25&status=active');
  });

  it('asks the server to filter, by status from the tabs, by type from the picker and by text from the box, and says so when nothing matches', async () => {
    const { requested } = server(base({
      '/api/projects/x/spores?limit=25&status=active': () => list(ROWS),
      '/api/projects/x/spores?limit=25': () => list([...ROWS, spore({ id: 'sp3', status: 'obsolete' })]),
      '/api/projects/x/spores?limit=25&type=gotcha': () => list([ROWS[0]]),
      '/api/projects/x/spores?limit=25&type=gotcha&q=nothing-here': () => list([]),
    }));
    mount('/p/x/spores');
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    fireEvent.change(screen.getByLabelText('Filter by type'), { target: { value: 'gotcha' } });
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1));
    expect(screen.getByTestId('spore-rail-counts').textContent).toBe('1 MATCHING');
    fireEvent.change(screen.getByLabelText('Filter spores'), { target: { value: 'nothing-here' } });
    expect(await screen.findByText('No spores match.')).toBeTruthy();
    expect(requested.filter((r) => r.startsWith('/api/projects/x/spores'))).toEqual([
      '/api/projects/x/spores?limit=25&status=active',
      '/api/projects/x/spores?limit=25',
      '/api/projects/x/spores?limit=25&type=gotcha',
      '/api/projects/x/spores?limit=25&type=gotcha&q=nothing-here',
    ]);
  });

  it('opens a spore from the rail and keeps the section active in the project nav', async () => {
    server(base({
      '/api/projects/x/spores?limit=25&status=active': () => list(ROWS),
      '/api/projects/x/spores/sp1': () => Response.json({ spore: ROWS[0], supersededBy: [], supersedes: [] }),
    }));
    mount('/p/x/spores');
    const rows = await screen.findAllByRole('row');
    fireEvent.click(rows[0]!);
    expect(await screen.findByRole('heading', { name: 'Gotcha' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Project' });
    expect([...nav.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Spores']);
  });

  it('shows a project with no spores as empty, not missing', async () => {
    server(base({ '/api/projects/x/spores?limit=25&status=active': () => list([]) }));
    mount('/p/x/spores');
    expect(await screen.findByText('No spores yet')).toBeTruthy();
    expect(screen.queryByText(/not found/i)).toBeNull();
  });
});

describe('Spore detail', () => {
  const SP = spore({
    id: 'sp9', observationType: 'trade_off', status: 'superseded', importance: 7,
    content: 'Paging by **offset** is what the owner route serves.',
    context: 'Found while reading the rail.',
    tags: '["paging","rail"]',
    filePath: 'ui/src/hooks/use-intelligence.ts',
  });

  const routes = (over: Record<string, () => Response> = {}) => base({
    '/api/projects/x/spores?limit=25&status=active': () => list([]),
    '/api/projects/x/spores/sp9': () => Response.json({ spore: SP, supersededBy: ['sp10'], supersedes: ['sp8'] }),
    ...over,
  });

  it('renders the observation, its context, tags, badges, the lineage in both directions and the session it came out of', async () => {
    server(routes());
    mount('/p/x/spores/sp9');
    expect(await screen.findByRole('heading', { name: 'Trade Off' })).toBeTruthy();
    expect(screen.getByTestId('spore-status').textContent).toBe('Superseded');
    expect(screen.getByText('importance 7')).toBeTruthy();
    expect(screen.getByText('offset')).toBeTruthy();
    expect(screen.getByText('Found while reading the rail.')).toBeTruthy();
    const tags = screen.getByLabelText('Tags');
    expect(within(tags).getByText('paging')).toBeTruthy();
    expect(within(tags).getByText('rail')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'sp8' }).getAttribute('href')).toBe('/p/x/spores/sp8');
    expect(screen.getByRole('link', { name: 'sp10' }).getAttribute('href')).toBe('/p/x/spores/sp10');
    expect(screen.getByText('Replaces')).toBeTruthy();
    expect(screen.getByText('Replaced by')).toBeTruthy();
    expect(screen.getByRole('link', { name: 's1' }).getAttribute('href')).toBe('/p/x/sessions/s1');
    expect(screen.getByText('ui/src/hooks/use-intelligence.ts')).toBeTruthy();
  });

  it('says a spore nothing has replaced still stands, and drops the context block when there is none', async () => {
    server(routes({ '/api/projects/x/spores/sp9': () => Response.json({ spore: { ...SP, context: null, tags: 'paging, rail' }, supersededBy: [], supersedes: [] }) }));
    mount('/p/x/spores/sp9');
    expect(await screen.findByText('This spore still stands as written.')).toBeTruthy();
    expect(screen.queryByText('Context')).toBeNull();
    expect(within(screen.getByLabelText('Tags')).getByText('paging')).toBeTruthy();
  });

  it('answers a spore the server does not hold with not found, never forbidden', async () => {
    server(routes({ '/api/projects/x/spores/gone': () => new Response(null, { status: 404 }) }));
    mount('/p/x/spores/gone');
    expect(await screen.findByText(/not found/i)).toBeTruthy();
    expect(screen.queryByText(/forbidden/i)).toBeNull();
  });
});

describe('Spore labels', () => {
  it('reads tags from a JSON array or a comma list, and previews one line of an observation', () => {
    expect(sporeTags('["a","b"]')).toEqual(['a', 'b']);
    expect(sporeTags('a, b ,')).toEqual(['a', 'b']);
    expect(sporeTags('[not json')).toEqual(['[not json']);
    expect(sporeTags(null)).toEqual([]);
    expect(sporePreview('# Title\n\nbody')).toBe('Title');
    expect(sporePreview('x'.repeat(200))).toBe(`${'x'.repeat(140)}…`);
  });
});
