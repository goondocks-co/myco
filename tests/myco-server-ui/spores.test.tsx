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

/** A wide screen for the duration of `fn`; the shim answers narrow otherwise. */
async function onWideScreen(fn: () => Promise<void>): Promise<void> {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query.includes('min-width'), media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  try { await fn(); } finally { window.matchMedia = original; }
}

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
    expect(screen.getByTestId('spore-rail-counts').textContent).toBe('2 ACTIVE');
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

  it('carries a pasted link straight into the request — status, type, text and page', async () => {
    const { requested } = server(base({ '/api/projects/x/spores?limit=25&status=obsolete&type=gotcha&q=cache&offset=25': () => list([ROWS[0]], 30) }));
    mount('/p/x/spores?status=obsolete&type=gotcha&q=cache&offset=25');
    await screen.findAllByRole('row');
    expect(requested.filter((r) => r.startsWith('/api/projects/x/spores'))).toEqual([
      '/api/projects/x/spores?limit=25&status=obsolete&type=gotcha&q=cache&offset=25',
    ]);
    // The pasted state is what the controls show.
    expect(screen.getByRole('tab', { name: 'Obsolete' }).getAttribute('aria-selected')).toBe('true');
    expect((screen.getByLabelText('Filter by type') as HTMLSelectElement).value).toBe('gotcha');
    expect((screen.getByLabelText('Filter spores') as HTMLInputElement).value).toBe('cache');
  });

  it('pages the match, and a change of status starts the next match at its first page', async () => {
    const { requested } = server(base({
      '/api/projects/x/spores?limit=25&status=active': () => list(ROWS, 30),
      '/api/projects/x/spores?limit=25&status=active&offset=25': () => list([ROWS[1]], 30),
      '/api/projects/x/spores?limit=25&status=obsolete': () => list([], 0),
    }));
    mount('/p/x/spores');
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(1));
    fireEvent.click(screen.getByRole('tab', { name: 'Obsolete' }));
    await screen.findByText('No spores match.');
    expect(requested.filter((r) => r.startsWith('/api/projects/x/spores'))).toEqual([
      '/api/projects/x/spores?limit=25&status=active',
      '/api/projects/x/spores?limit=25&status=active&offset=25',
      '/api/projects/x/spores?limit=25&status=obsolete',
    ]);
  });

  it('says the spores could not be read when the server fails, and never reads that as an empty project', async () => {
    server(base({ '/api/projects/x/spores?limit=25&status=active': () => new Response(null, { status: 500 }) }));
    mount('/p/x/spores');
    expect(await screen.findByText('The spores could not be read')).toBeTruthy();
    expect(screen.queryByText('No spores yet')).toBeNull();
    expect(screen.queryByText('No active spores.')).toBeNull();
  });

  it('tells a project whose spores have all been retired from one that has none, and says where the retired ones are', async () => {
    server(base({
      '/api/projects/x/spores?limit=25&status=active': () => list([], 0),
      '/api/projects/x/spores?limit=1': () => list([spore({ status: 'obsolete' })], 3),
    }));
    mount('/p/x/spores');
    expect(await screen.findByText('No active spores.')).toBeTruthy();
    expect(await screen.findByText('3 retired spores are under All.')).toBeTruthy();
    expect(screen.queryByText('No spores yet')).toBeNull();
    expect(screen.getByTestId('spore-rail-counts').textContent).toBe('0 ACTIVE');
  });

  it('opens the top spore on its own on a wide screen when nothing is selected, and never while a filter is hunting', async () => onWideScreen(async () => {
    server(base({
      '/api/projects/x/spores?limit=25&status=active': () => list(ROWS),
      '/api/projects/x/spores?limit=25&status=active&type=gotcha': () => list([ROWS[0]]),
      '/api/projects/x/spores/sp1': () => Response.json({ spore: ROWS[0], supersededBy: [], supersedes: [] }),
    }));
    const opened = mount('/p/x/spores');
    expect(await screen.findByRole('heading', { name: 'Gotcha' })).toBeTruthy();
    opened.unmount();
    mount('/p/x/spores?type=gotcha');
    await screen.findAllByRole('row');
    expect(screen.getByText('Select a spore to read it.')).toBeTruthy();
  }));

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

  it('shows a project with no spores at all as empty, not missing', async () => {
    server(base({ '/api/projects/x/spores?limit=25': () => list([]) }));
    mount('/p/x/spores?status=all');
    expect(await screen.findByText('No spores yet')).toBeTruthy();
    expect(screen.getByTestId('spore-rail-counts').textContent).toBe('0 TOTAL');
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
    '/api/projects/x/spores/sp9': () => Response.json({ spore: SP, supersededBy: ['sp10'], supersedes: ['01234567-89ab-cdef'] }),
    ...over,
  });

  it('renders the observation, its context, tags, badges, the lineage in both directions and the session it came out of', async () => {
    server(routes());
    mount('/p/x/spores/sp9');
    expect(await screen.findByRole('heading', { name: 'Trade Off' })).toBeTruthy();
    expect(screen.getByTestId('spore-status').textContent).toBe('Superseded');
    expect(screen.getByText('Importance 7 of 10')).toBeTruthy();
    expect(screen.getByText('offset')).toBeTruthy();
    expect(screen.getByText('Found while reading the rail.')).toBeTruthy();
    const tags = screen.getByLabelText('Tags');
    expect(within(tags).getByText('paging')).toBeTruthy();
    expect(within(tags).getByText('rail')).toBeTruthy();
    const predecessor = screen.getByRole('link', { name: '01234567' });
    expect(predecessor.getAttribute('href')).toBe('/p/x/spores/01234567-89ab-cdef');
    expect(predecessor.getAttribute('title')).toBe('01234567-89ab-cdef');
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
