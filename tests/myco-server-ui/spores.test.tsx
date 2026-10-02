/**
 * Knowledge's spores: the stream across every project and within one, its
 * filter bar and facets, paging, the old addresses, and a spore's article with
 * where it came from and how it changed.
 *
 * The clock is held at a fixed afternoon so every instant below sits on the day
 * it names, whatever the machine's own time.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { sporeAuthor, sporeHeadline, sporeTags, typeFacetRows, windowSince } from '../../packages/myco-server/ui/src/features/knowledge/words';
import { rawIdsIn } from '../helpers/raw-ids';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tuesday, September 29 2026, 16:00 local. */
const NOW = new Date(2026, 8, 29, 16, 0, 0).getTime();


const ADMIN = { sub: '1', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const PROJECTS = { projects: [
  { projectId: 'proj_6d79636f3a3e1c0b', name: 'Myco', createdAt: 0, sessionCount: 3, lastActivityAt: NOW },
  { projectId: 'proj_a71a5c0e2b9d4f8e', name: 'Atlas web', createdAt: 0, sessionCount: 1, lastActivityAt: NOW - HOUR },
] };
const MYCO = 'proj_6d79636f3a3e1c0b';
const ATLAS = 'proj_a71a5c0e2b9d4f8e';
const MEMBERS = { members: [
  { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  { id: 'mem_harness', label: 'harness', role: 'admin', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0 },
] };

const spore = (over: Record<string, unknown> = {}) => ({
  projectId: MYCO, id: 'gotcha-1a2b3c4d', agentId: 'agent_1', sessionId: 's1', promptId: null, observationType: 'gotcha', status: 'active',
  content: 'The cache lies after a rebase.\n\nClear it on checkout.', context: null, importance: 8, filePath: 'src/cache.ts', tags: null,
  contentHash: null, properties: null, author: 'run_4f1c9a2e7b', authorKind: 'run', provenanceKind: null, provenanceRef: null,
  agentLine: 'The cache lies after a rebase; clear it on checkout.', createdAt: NOW - HOUR, updatedAt: null, embedded: 0, ...over,
});
const FACETS = { type: { gotcha: 3, decision: 2, bug_fix: 1 }, project: { [MYCO]: 4, [ATLAS]: 2 } };
const stream = (spores: unknown[], total = spores.length, facets: unknown = FACETS) => Response.json({ spores, total, maxPage: 200, ...(facets === null ? {} : { facets }) });

const ROWS = [
  spore(),
  spore({ id: 'decision-2b3c4d5e', projectId: ATLAS, observationType: 'decision', agentLine: 'Validation messages name the field and the fix.', createdAt: NOW - 2 * HOUR }),
  // Saved without its one line: headlined by its type and day, with the start of what it says beneath.
  spore({ id: 'bug_fix-3c4d5e6f', observationType: 'bug_fix', agentLine: null, content: '# Port race\n\nBind port 0.', createdAt: NOW - DAY - HOUR }),
];

const originalFetch = globalThis.fetch;
(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;
beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; setSystemTime(); forgetProject(); });

type Routes = Record<string, () => Response | Promise<Response>>;

/** Answers a path with its query first, then the path alone; anything else is 404. Records every request. */
function server(routes: Routes): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    return routes[url.pathname + url.search]?.() ?? routes[url.pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

const base = (extra: Routes = {}): Routes => ({
  '/auth/me': () => Response.json(ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  ...extra,
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const location = () => screen.getByTestId('location').textContent;
const asked = (requested: string[], url: string) => waitFor(() => expect(requested).toContain(url));

/** Opens a design-system select by its label and picks one option, the way a person does. */
async function pick(label: string, option: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

function screenWidth(width: number): void {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max === null || width <= Number(max[1])) && (min === null || width >= Number(min[1]));
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = originalMatchMedia; });

/** Visible text carrying a raw id, outside the facts panel and the test's own location probe. */
const rawIdsInPage = (): string[] => rawIdsIn(document.body, ['[data-testid="location"]']);

const cards = () => [...document.querySelectorAll<HTMLElement>('[data-spore-stream] li[data-spore]')];

describe('the spore stream', () => {
  it('lists current spores across every project, headlined by their one line, under the day each was saved', async () => {
    const { requested } = server(base({ '/api/spores?status=active&limit=25': () => stream(ROWS, 6) }));
    mount('/knowledge');
    expect(await screen.findByRole('heading', { level: 1, name: 'Knowledge' })).toBeTruthy();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(requested).toContain('/api/spores?status=active&limit=25');
    const [first, second, third] = cards();
    expect(within(first!).getByRole('link').textContent).toBe('The cache lies after a rebase; clear it on checkout.');
    expect(first!.textContent).toContain('Gotcha');
    expect(first!.textContent).toContain('Myco');
    expect(second!.textContent).toContain('Atlas web');
    expect(second!.textContent).toContain('Decision');
    // No one line: the type and the day head it, and the start of what it says follows.
    expect(within(third!).getByRole('link').textContent).toBe('Fix saved Sep 28');
    expect(third!.textContent).toContain('Port race');
    expect(third!.hasAttribute('data-unlined')).toBe(true);
    const days = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent).filter((t) => t === 'Today' || t === 'Yesterday');
    expect(days).toEqual(['Today', 'Yesterday']);
    expect(within(first!).getByRole('link').getAttribute('href')).toBe(`/p/${MYCO}/spores/gotcha-1a2b3c4d`);
    expect(screen.getByText('6 current spores')).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Knowledge sections' })).getAllByRole('link').map((a) => a.textContent)).toEqual(['Spores', 'Plans']);
    expect(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Knowledge' }).getAttribute('aria-current')).toBe('page');
    expect(rawIdsInPage()).toEqual([]);
  });

  it('marks a spore no longer current, and filters by status, period and words on the server, all in the URL', async () => {
    const since = windowSince('week', NOW);
    const { requested } = server(base({
      '/api/spores?status=active&limit=25': () => stream(ROWS),
      '/api/spores?status=superseded&limit=25': () => stream([spore({ id: 'gotcha-9a8b7c6d', status: 'superseded', agentLine: 'The old port rule.' })]),
      [`/api/spores?status=superseded&since=${since}&limit=25`]: () => stream([spore({ id: 'gotcha-9a8b7c6d', status: 'superseded', agentLine: 'The old port rule.' })]),
      [`/api/spores?status=superseded&q=port&since=${since}&limit=25`]: () => stream([]),
    }));
    mount('/knowledge');
    await waitFor(() => expect(cards()).toHaveLength(3));
    await pick('Status', 'Replaced');
    await asked(requested, '/api/spores?status=superseded&limit=25');
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]!.textContent).toContain('Replaced');
    expect(cards()[0]!.getAttribute('data-spore')).toBe('superseded');
    await pick('Saved', 'Saved in the past 7 days');
    await asked(requested, `/api/spores?status=superseded&since=${since}&limit=25`);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter spores' }), { target: { value: 'port' } });
    await asked(requested, `/api/spores?status=superseded&q=port&since=${since}&limit=25`);
    expect(await screen.findByText('No spores match.')).toBeTruthy();
    expect(location()).toBe('/knowledge?status=superseded&window=week&q=port');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await waitFor(() => expect(location()).toBe('/knowledge'));
    await waitFor(() => expect(cards()).toHaveLength(3));
  });

  it('shows the type and project facets with the server’s counts; a type narrows in place, a project leads to its Knowledge with the filters kept', async () => {
    const { requested } = server(base({
      '/api/spores?status=active&limit=25': () => stream(ROWS),
      '/api/spores?type=decision&status=active&limit=25': () => stream([ROWS[1]], 2, { ...FACETS, project: { [ATLAS]: 2 } }),
      [`/api/spores?project=${ATLAS}&type=decision&status=active&limit=25`]: () => stream([ROWS[1]], 2),
    }));
    mount('/knowledge');
    await waitFor(() => expect(cards()).toHaveLength(3));
    const types = screen.getByRole('region', { name: 'Type' });
    const typeRows = within(types).getAllByRole('button');
    expect(typeRows.map((b) => b.textContent)).toEqual(['Everything6', 'Decisions2', 'Gotchas3', 'Fixes1']);
    expect(typeRows[0]!.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(types).getByRole('button', { name: /Decisions/ }));
    await asked(requested, '/api/spores?type=decision&status=active&limit=25');
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(location()).toBe('/knowledge?type=decision');
    // Everything still counts every type under the other filters, not the two spores the picked type holds.
    const picked = within(screen.getByRole('region', { name: 'Type' })).getAllByRole('button');
    expect(picked[0]!.textContent).toBe('Everything6');
    expect(picked[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(within(screen.getByRole('region', { name: 'Type' })).getByRole('button', { name: /Decisions/ }).getAttribute('aria-pressed')).toBe('true');
    const projects = screen.getByRole('region', { name: 'Project' });
    expect(within(projects).getAllByRole('link').map((a) => a.textContent)).toEqual(['All projects2', 'Atlas web2']);
    fireEvent.click(within(projects).getByRole('link', { name: /Atlas web/ }));
    await waitFor(() => expect(location()).toBe(`/p/${ATLAS}/knowledge?type=decision`));
    await asked(requested, `/api/spores?project=${ATLAS}&type=decision&status=active&limit=25`);
    // Within one project the cards leave the project out, and "All projects" leads back.
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]!.textContent).not.toContain('Atlas web');
    expect(within(screen.getByRole('region', { name: 'Project' })).getByRole('link', { name: /All projects/ }).getAttribute('href')).toBe('/knowledge?type=decision');
    expect(within(screen.getByRole('navigation', { name: 'Knowledge sections' })).getAllByRole('link').map((a) => a.textContent)).toEqual(['Spores', 'Plans', 'Code map']);
  });

  it('moves the type into the filter bar on a narrow screen', async () => {
    screenWidth(390);
    const { requested } = server(base({
      '/api/spores?status=active&limit=25': () => stream(ROWS),
      '/api/spores?type=gotcha&status=active&limit=25': () => stream([ROWS[0]], 1),
    }));
    mount('/knowledge');
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.queryByRole('region', { name: 'Type' })).toBeNull();
    await pick('Type', 'Gotchas (3)');
    await asked(requested, '/api/spores?type=gotcha&status=active&limit=25');
  });

  it('reads the next page from where the loaded spores end, listing a repeated spore once', async () => {
    const page = Array.from({ length: 25 }, (_, i) => spore({ id: `a${i}`, agentLine: `Spore number ${i}`, createdAt: NOW - (i + 1) * MINUTE }));
    const { requested } = server(base({
      '/api/spores?status=active&limit=25': () => stream(page, 27),
      '/api/spores?status=active&limit=25&offset=25': () => stream([page[24], spore({ id: 'b1', agentLine: 'Spore after the page' })], 27, null),
    }));
    mount('/knowledge');
    await waitFor(() => expect(cards()).toHaveLength(25));
    expect(screen.getByText('Showing 25 of 27 spores')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await asked(requested, '/api/spores?status=active&limit=25&offset=25');
    await waitFor(() => expect(cards()).toHaveLength(26));
    expect(screen.getByText('Spore after the page')).toBeTruthy();
    // The facets came with the first page and still count the whole match.
    expect(within(screen.getByRole('region', { name: 'Type' })).getAllByRole('button')[0]!.textContent).toBe('Everything6');
  });

  it('says there are none yet on a quiet deployment, and none match when filtered', async () => {
    server(base({ '/api/spores?status=active&limit=25': () => stream([], 0, { type: {}, project: {} }) }));
    mount('/knowledge');
    expect(await screen.findByText('No spores yet. Myco writes them as it learns from your sessions.')).toBeTruthy();
  });

  it('sends the old spores list, with its filters, to Knowledge under the same project', async () => {
    const { requested } = server(base({ [`/api/spores?project=${MYCO}&type=gotcha&status=superseded&limit=25`]: () => stream([spore({ status: 'superseded' })], 1) }));
    mount(`/p/${MYCO}/spores?status=superseded&type=gotcha&offset=25`);
    await waitFor(() => expect(location()).toBe(`/p/${MYCO}/knowledge?status=superseded&type=gotcha`));
    await asked(requested, `/api/spores?project=${MYCO}&type=gotcha&status=superseded&limit=25`);
  });

  it('says not found for a project that does not exist', async () => {
    server(base());
    mount('/p/nope/knowledge');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});

describe('a spore’s article', () => {
  const article = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => Response.json({
    spore: { ...spore({ status: 'superseded', promptId: 'p1', context: 'Seen on **both** targets.', tags: '["cache","git"]', ...over }), sourceCreatedAt: NOW - 90 * MINUTE },
    supersededBy: ['gotcha-7a8b9c0d'], supersedes: ['gotcha-0a1b2c3d'], ...extra,
  });
  const sessionAnswer = Response.json({
    session: { projectId: MYCO, sessionId: 's1', agent: 'codex', title: 'Flaky test port collision fixed', label: 's1', summary: null, startedAt: NOW - 2 * HOUR, firstReceivedAt: NOW - 2 * HOUR, lastReceivedAt: NOW - HOUR, endedAt: NOW - HOUR, memberId: null, memberLabel: null, runtimeLabel: null, branch: null, originPath: null, parentSessionId: null, parentReason: null, endedBy: null, endedByLabel: null },
    untitled: null, counts: { prompts: 2, toolCalls: 0, responses: 2, plans: 0, attachments: 0 }, release: null, outcome: { runs: [], spores: { total: 0, items: [] } }, projectId: MYCO,
  });
  const neighbour = (id: string, line: string) => () => Response.json({ spore: { ...spore({ id, agentLine: line }), sourceCreatedAt: null }, supersededBy: [], supersedes: [] });

  it('reads as an article: the replacement first, the one line, the body, context, tags, how it changed, where it came from and the facts', async () => {
    server(base({
      [`/api/projects/${MYCO}/spores/gotcha-1a2b3c4d`]: () => article(),
      [`/api/projects/${MYCO}/spores/gotcha-7a8b9c0d`]: neighbour('gotcha-7a8b9c0d', 'Clear the cache on every checkout, not only after a rebase.'),
      [`/api/projects/${MYCO}/spores/gotcha-0a1b2c3d`]: () => new Response(null, { status: 404 }),
      [`/api/projects/${MYCO}/sessions/s1`]: () => sessionAnswer,
    }));
    mount(`/p/${MYCO}/spores/gotcha-1a2b3c4d`);
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toBe('The cache lies after a rebase; clear it on checkout.');
    // The page names its project in the scope switcher beside its breadcrumbs, and offers no "All projects": it belongs to one.
    const scope = screen.getByRole('button', { name: 'Showing: Myco' });
    fireEvent.keyDown(scope, { key: 'Enter' });
    const scopes = await screen.findByRole('menu', { name: /^Showing: / });
    expect(scopes.querySelector('[data-scope-option="all"]')).toBeNull();
    expect(scopes.querySelector('[data-scope-all-reason]')!.textContent).toBe('This page belongs to one project.');
    fireEvent.keyDown(scopes, { key: 'Escape' });
    const page = document.querySelector('[data-spore-article]')!;
    // The replacement leads, named by its line.
    const replaced = page.querySelector('[data-spore-replaced]') as HTMLElement;
    expect(replaced.textContent).toContain('This spore was replaced.');
    const next = await within(replaced).findByRole('link', { name: 'Clear the cache on every checkout, not only after a rebase.' });
    expect(next.getAttribute('href')).toBe(`/p/${MYCO}/spores/gotcha-7a8b9c0d`);
    expect(within(page as HTMLElement).getByText('Replaced', { selector: '[data-spore-status]' })).toBeTruthy();
    expect(page.querySelector('[data-spore-body]')!.textContent).toContain('Clear it on checkout.');
    expect(page.querySelector('[data-spore-context]')!.textContent).toContain('Seen on both targets.');
    expect(within(screen.getByRole('list', { name: 'Tags' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['cache', 'git']);
    // At its foot, what it replaced: here a spore the project no longer holds.
    const lineage = page.querySelector('[data-spore-lineage]') as HTMLElement;
    expect(within(lineage).getByRole('heading', { name: 'What it replaced' })).toBeTruthy();
    expect(await within(lineage).findByText('A spore this project no longer holds')).toBeTruthy();
    expect(within(lineage).queryByRole('link', { name: /Clear the cache on every checkout/ })).toBeNull();
    // Where it came from: the session by its title, the turn, and the run that wrote it.
    const origin = page.querySelector('[data-spore-origin]') as HTMLElement;
    expect(await within(origin).findByText('Flaky test port collision fixed')).toBeTruthy();
    expect(within(origin).getByRole('link', { name: 'Open the session →' }).getAttribute('href')).toBe(`/p/${MYCO}/sessions/s1`);
    expect(within(origin).getByRole('link', { name: 'The turn it came from →' }).getAttribute('href')).toBe(`/p/${MYCO}/sessions/s1?turn=p1`);
    expect(within(origin).getByRole('link', { name: 'The run that wrote it →' }).getAttribute('href')).toBe(`/p/${MYCO}/work/runs/run_4f1c9a2e7b`);
    const facts = page.querySelector('[data-facts]') as HTMLElement;
    expect(facts.textContent).toContain('Importance8 of 10');
    expect(facts.textContent).toContain('src/cache.ts');
    expect(within(facts).getByRole('button', { name: 'Copy spore id' })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Knowledge', `/p/${MYCO}/knowledge`], ['Spores', `/p/${MYCO}/knowledge`], ['Myco', `/p/${MYCO}`],
    ]);
    expect(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Knowledge' }).getAttribute('aria-current')).toBe('page');
    expect(rawIdsInPage()).toEqual([]);
  });

  it('names a member who saved it by name, and a spore without its line by its type and day', async () => {
    server(base({
      [`/api/projects/${MYCO}/spores/gotcha-1a2b3c4d`]: () => article({ status: 'active', author: 'mem_q3Vb8xRk2LmT7wYz', authorKind: 'member', agentLine: null, observationType: 'decision', context: null, tags: null }, { supersededBy: [], supersedes: [] }),
      [`/api/projects/${MYCO}/sessions/s1`]: () => sessionAnswer,
    }));
    mount(`/p/${MYCO}/spores/gotcha-1a2b3c4d`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Decision saved Sep 29');
    expect(await screen.findByText('Saved by Ada.')).toBeTruthy();
    expect(document.querySelector('[data-spore-replaced]')).toBeNull();
    expect(document.querySelector('[data-spore-lineage]')).toBeNull();
    expect(rawIdsInPage()).toEqual([]);
  });

  it('says a spore Myco 1.4 wrote was imported, by the kind the server names, never by the author id’s shape', async () => {
    server(base({
      // Imported spores carry the importing member as their author; only the kind tells them apart.
      [`/api/projects/${MYCO}/spores/gotcha-1a2b3c4d`]: () => article({ author: 'mem_q3Vb8xRk2LmT7wYz', authorKind: 'imported' }, { supersededBy: [], supersedes: [] }),
      [`/api/projects/${MYCO}/sessions/s1`]: () => sessionAnswer,
    }));
    mount(`/p/${MYCO}/spores/gotcha-1a2b3c4d`);
    await waitFor(() => expect(document.querySelector('[data-spore-author]')).not.toBeNull());
    const origin = document.querySelector('[data-spore-author]') as HTMLElement;
    expect(origin.getAttribute('data-spore-author')).toBe('imported');
    expect(origin.textContent).toBe('Imported from Myco 1.4.');
    expect(screen.queryByText(/Saved by/)).toBeNull();
    expect(rawIdsInPage()).toEqual([]);
  });

  it('says not found for a spore the project does not hold', async () => {
    server(base());
    mount(`/p/${MYCO}/spores/missing`);
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});

describe('the knowledge words', () => {
  it('reads each author, headline, tag list, facet and period', () => {
    expect([
      sporeAuthor({ author: 'run_abc123', authorKind: 'run' }), sporeAuthor({ author: 'mem_q3Vb8xRk2L', authorKind: 'member' }), sporeAuthor({ author: 'mem_q3Vb8xRk2L', authorKind: 'imported' }),
      sporeAuthor({ author: 'eg_1', authorKind: 'grant' }), sporeAuthor({ author: null, authorKind: null }), sporeAuthor({ author: 'run_abc123' }),
      // The kind decides, not the id's prefix: a run pruned by retention still reads as a run.
      sporeAuthor({ author: 'a1b2c3', authorKind: 'run' }),
    ]).toEqual([
      { kind: 'run', runId: 'run_abc123' }, { kind: 'member', memberId: 'mem_q3Vb8xRk2L' }, { kind: 'imported' },
      { kind: 'key' }, { kind: 'unknown' }, { kind: 'unknown' },
      { kind: 'run', runId: 'a1b2c3' },
    ]);
    expect(sporeHeadline({ agentLine: '  ', observationType: 'trade_off', createdAt: NOW }, NOW)).toEqual({ text: 'Trade-off saved Sep 29', lined: false });
    expect(sporeTags('a, b')).toEqual(['a', 'b']);
    expect(sporeTags('["a","b"]')).toEqual(['a', 'b']);
    expect(typeFacetRows({ gotcha: 2, novel: 1 }).map((row) => row.type).slice(-1)).toEqual(['novel']);
    expect(windowSince('all', NOW)).toBeNull();
    expect(windowSince('week', NOW)).toBe(new Date(2026, 8, 23).getTime());
  });
});
