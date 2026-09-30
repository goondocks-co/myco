/**
 * ⌘K: search this project or every project. A page under a project starts on
 * that project and one that names none starts on everything; results group by
 * kind, lead with what they say, name their project across projects, and are
 * reached by the keyboard.
 */
import { afterEach, expect, it } from 'bun:test';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchTrigger, useSearchShortcut } from '../../packages/myco-server/ui/src/design';
import { Search } from '../../packages/myco-server/ui/src/features/search/Search';
import { searchResultPath, SEARCH_RESULT_CAP, type SearchAcrossResult } from '../../packages/myco-server/ui/src/hooks/use-search';
import { RAW_ID } from '../helpers/raw-ids';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;

const NAMES: Record<string, string> = { one: 'Project one', two: 'Project two', proj_6d79636f3a3e1c0b: 'Myco' };
const hit = (overrides: Partial<SearchAcrossResult> = {}): SearchAcrossResult => ({ projectId: 'one', id: 'sp', type: 'spore', title: 'decision', preview: 'Use a bounded cache.', score: 1, ...overrides });
const answer = (results: unknown[], pending = 0, unavailable = false) => Response.json({ results, mode: 'fts', provider_unavailable: unavailable, coverage: { pending_blobs: pending } });
function Location() { return <output data-testid="location">{useLocation().pathname}{useLocation().search}</output>; }

/** The shell's wiring in small: a trigger, the shortcut, and the search keyed by the project it searches. */
function Harness({ project, scoped }: { project: string; scoped: boolean }) {
  const [open, setOpen] = useState(false);
  useSearchShortcut(() => setOpen((value) => !value));
  return (
    <>
      <SearchTrigger onOpen={() => setOpen(true)} />
      <Search key={`${project}/${scoped}`} open={open} onOpenChange={setOpen} project={{ projectId: project, name: NAMES[project]! }} scoped={scoped} projectName={(id) => NAMES[id] ?? null} />
    </>
  );
}

function mount(scoped = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (project: string) => <QueryClientProvider client={client}><MemoryRouter><Harness project={project} scoped={scoped} /><Location /></MemoryRouter></QueryClientProvider>;
  const rendered = render(tree('one'));
  return { ...rendered, client, project: (name: string) => rendered.rerender(tree(name)) };
}

/** Opens a design-system select by its label, the searchable form included, and picks one option. */
async function pick(label: string, option: string) {
  await waitFor(() => expect(screen.queryAllByRole('combobox', { name: label }).length + screen.queryAllByRole('button', { name: new RegExp(`^${label}:`) }).length).toBeGreaterThan(0));
  const [trigger] = screen.queryAllByRole('combobox', { name: label }).concat(screen.queryAllByRole('button', { name: new RegExp(`^${label}:`) }));
  fireEvent.click(trigger!);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

it('searches the project a page names, debounced, with its filters, and opens a result by keyboard', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (path: string) => { asked.push(new URL(path, 'https://s')); return answer([hit()], 2); }) as typeof fetch;
  mount();
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = await screen.findByRole('searchbox', { name: 'Search this project' });
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole('dialog').textContent).toContain('Search Project one');
  fireEvent.change(input, { target: { value: 'c' } });
  expect(asked).toHaveLength(0);
  fireEvent.change(input, { target: { value: 'cache' } });
  await screen.findByRole('link', { name: /Use a bounded cache/ });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.pathname).toBe('/api/projects/one/search');
  expect(asked[0]!.searchParams.get('mode')).toBe('auto');
  expect(asked[0]!.searchParams.get('limit')).toBe(String(SEARCH_RESULT_CAP));
  expect(await screen.findByText(/Indexing 2 captured bodies/)).toBeDefined();
  await pick('Result type', 'Spores');
  await pick('Spore type', 'Fixes');
  await waitFor(() => expect(asked.at(-1)!.searchParams.get('observation_type')).toBe('bug_fix'));
  expect(asked.at(-1)!.searchParams.get('type')).toBe('spore');
  await screen.findByRole('link', { name: /Use a bounded cache/ });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toContain('Use a bounded cache.');
  fireEvent.click(screen.getByRole('link', { name: /Use a bounded cache/ }));
  expect(screen.getByTestId('location').textContent).toBe('/p/one/spores/sp');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('searches every project on request: grouped by kind, each result naming its project, the keyboard moving across the groups', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (path: string) => {
    const url = new URL(path, 'https://s');
    asked.push(url);
    if (url.pathname !== '/api/search') return answer([hit()]);
    return answer([
      hit({ projectId: 'two', type: 'session', id: 's1', title: 'Checkout form validation messages rewritten', preview: 'Replaced the generic errors.' }),
      hit({ projectId: 'proj_6d79636f3a3e1c0b', type: 'spore', id: 'sp2', title: 'gotcha', preview: 'A test that reserves a fixed port races the fallback.' }),
      hit({ projectId: 'two', type: 'plan', id: 'k1', session_id: 's1', title: 'One filter bar', preview: 'Sessions, Knowledge' }),
      hit({ projectId: 'one', type: 'session', id: 's2', title: 'Session 7f3e2a', preview: 'Run the parity scenarios' }),
      hit({ projectId: 'one', type: 'skill', id: 'sk', title: 'A skill', preview: 'Never shown' }),
    ]);
  }) as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  const scope = screen.getByRole('group', { name: 'Search in' });
  expect(within(scope).getByRole('button', { name: 'Project one' }).getAttribute('aria-pressed')).toBe('true');
  // The scope says on its face that every project is searched by words only.
  fireEvent.click(within(scope).getByRole('button', { name: 'Every project · words only' }));
  expect(within(scope).getByRole('button', { name: /^Every project/ }).getAttribute('aria-pressed')).toBe('true');
  const input = screen.getByRole('searchbox', { name: 'Search every project' });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'form' } });
  await screen.findByRole('link', { name: /fixed port/ });
  const across = asked.filter((url) => url.pathname === '/api/search');
  expect(across).toHaveLength(1);
  expect(across[0]!.searchParams.get('mode')).toBeNull();
  expect(asked.some((url) => url.pathname.startsWith('/api/projects/'))).toBe(false);
  // Grouped: spores, plans, sessions; the skill is left out.
  expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Spores1', 'Plans1', 'Sessions2']);
  const spore = screen.getByRole('link', { name: /fixed port/ });
  expect(spore.textContent).toContain('Gotcha');
  expect(spore.textContent).toContain('Myco');
  expect(spore.getAttribute('href')).toBe('/p/proj_6d79636f3a3e1c0b/spores/sp2');
  expect(screen.getByRole('link', { name: /One filter bar/ }).getAttribute('href')).toBe('/p/two/plans/k1?session=s1');
  // A session titled only by the end of its id reads what it says.
  expect(screen.getByRole('link', { name: /Run the parity scenarios/ }).textContent).not.toContain('7f3e2a');
  expect(screen.queryByText('Never shown')).toBeNull();
  // The count is announced in one status line, not the whole list.
  expect(screen.getByRole('status').textContent).toBe('4 results');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(spore);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toContain('One filter bar');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement?.textContent).toContain('Checkout form validation');
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(input);
  const dialogText = screen.getByRole('dialog').textContent ?? '';
  expect(RAW_ID.test(dialogText)).toBe(false);
});

it('starts on every project from a page that names none, and says when the cap cut the list, counting what the server sent', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (path: string) => {
    asked.push(new URL(path, 'https://s'));
    // The cap counts what came back, skills included, though the list leaves them out.
    return answer(Array.from({ length: SEARCH_RESULT_CAP }, (_, i) => hit({ id: `sp${i}`, preview: `Result ${i}`, ...(i < 3 ? { type: 'skill' as const } : {}) })));
  }) as typeof fetch;
  mount(false);
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  expect(screen.getByRole('dialog').textContent).toContain('Search every project');
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search every project' }), { target: { value: 'result' } });
  expect(await screen.findByText(`The ${SEARCH_RESULT_CAP} best matches. Add words or a filter to narrow them.`)).toBeTruthy();
  expect(asked[0]!.pathname).toBe('/api/search');
});

it('says a project’s search matched words when search by meaning is unavailable', async () => {
  globalThis.fetch = (async () => answer([hit()], 0, true)) as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cache' } });
  expect(await screen.findByText(/Search by meaning is unavailable, so this matched words\./)).toBeTruthy();
});

it('keeps the results, and the keyboard’s place in them, while the search is read again in the background', async () => {
  let reads = 0;
  let release: (() => void) | undefined;
  const results = () => answer([hit(), hit({ id: 'sp2', preview: 'Evict the oldest entry first.' })], 3);
  globalThis.fetch = (async () => {
    reads += 1;
    if (reads === 1) return results();
    // The background read stays in flight until the test lets it answer.
    return new Promise<Response>((resolve) => { release = () => resolve(results()); });
  }) as typeof fetch;
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'cache' } });
  await screen.findByRole('link', { name: /Use a bounded cache/ });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  const focused = document.activeElement;
  expect(focused?.textContent).toContain('Evict the oldest entry first.');
  const refetch = view.client.refetchQueries({ queryKey: ['search'] });
  await waitFor(() => expect(release).toBeDefined());
  // Let React commit whatever the in-flight state renders.
  await new Promise((resolve) => setTimeout(resolve, 20));
  // While it is in flight the list stays, and so does the keyboard's place in it. Compared as words and a boolean, so a failure never prints the element.
  expect(document.body.textContent).not.toContain('Searching…');
  expect(document.activeElement === focused).toBe(true);
  release!();
  await refetch;
  expect(document.body.textContent).not.toContain('Searching…');
  expect(document.activeElement === focused).toBe(true);
  expect(screen.getByRole('link', { name: /Use a bounded cache/ })).toBeTruthy();
});

it('hides stale matches while typing and discards a pending search when the project changes', async () => {
  let finish: ((response: Response) => void) | undefined;
  const asked: string[] = [];
  globalThis.fetch = (async (path: string) => {
    asked.push(path);
    if (path.includes('q=second')) return new Promise<Response>((resolve) => { finish = resolve; });
    return answer([hit()]);
  }) as typeof fetch;
  const view = mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  const input = screen.getByRole('searchbox');
  fireEvent.change(input, { target: { value: 'first' } });
  await screen.findByRole('link', { name: /Use a bounded cache/ });
  fireEvent.change(input, { target: { value: 'second' } });
  expect(screen.queryByRole('link', { name: /Use a bounded cache/ })).toBeNull();
  await waitFor(() => expect(finish).toBeDefined());
  view.project('two');
  finish!(answer([hit({ preview: 'Private to one' })]));
  expect((await screen.findByRole('searchbox') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('dialog').textContent).toContain('Search Project two');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText('Private to one')).toBeNull();
  expect(asked.every((path) => path.startsWith('/api/projects/one/'))).toBe(true);
});

it('shows a failed request as a failure and supports retry', async () => {
  let failed = true;
  globalThis.fetch = (async () => failed ? new Response(null, { status: 503 }) : answer([])) as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cache' } });
  await screen.findByRole('alert');
  expect(screen.queryByText('No results match this search.')).toBeNull();
  failed = false;
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('No results match this search.');
});

it('opens a plan on its own page, a reply at its turn, and gives a skill hit no link at all', () => {
  expect(searchResultPath('a/b', hit({ type: 'plan', id: 'p&1', session_id: 's' }))).toBe('/p/a%2Fb/plans/p%261?session=s');
  expect(searchResultPath('p', hit({ type: 'plan', id: 'k' }))).toBe('/p/p/plans/k');
  expect(searchResultPath('p', hit({ type: 'response', session_id: 's', prompt_id: 'turn' }))).toBe('/p/p/sessions/s?turn=turn');
  expect(searchResultPath('p', hit({ type: 'skill', id: 'skill' }))).toBeNull();
});

it('opens on ⌘K and Ctrl K from every page: under a project it searches that project, elsewhere every project with the last one offered', async () => {
  const { default: App } = await import('../../packages/myco-server/ui/src/App');
  const { AppearanceProvider } = await import('../../packages/myco-server/ui/src/providers/appearance');
  const { rememberProject, forgetProject } = await import('../../packages/myco-server/ui/src/lib/project-memory');
  const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris', role: 'admin' as const } };
  const PROJECTS = { projects: ['one', 'two'].map((id) => ({ projectId: id, name: `Project ${id}`, createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: null, archivedBy: null })) };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://s');
    if (url.pathname === '/auth/me') return Response.json(ME);
    if (url.pathname === '/api/projects') return Response.json(PROJECTS);
    return Response.json({ error: 'not_found' }, { status: 404 });
  }) as typeof fetch;
  try {
    for (const [path, remembered, expected, offered, key] of [
      ['/measures', 'two', 'Search every project', 'Project two', { metaKey: true }],
      ['/p/one/knowledge/map', null, 'Search Project one', 'Project one', { ctrlKey: true }],
    ] as const) {
      if (remembered === null) forgetProject(); else rememberProject(remembered);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
      await screen.findByRole('button', { name: /Search/ });
      fireEvent.keyDown(document, { key: 'k', ...key });
      const dialog = await screen.findByRole('dialog');
      expect(dialog.textContent).toContain(expected);
      expect(within(within(dialog).getByRole('group', { name: 'Search in' })).getByRole('button', { name: offered })).toBeTruthy();
      fireEvent.keyDown(document, { key: 'k', ...key });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      cleanup();
    }
  } finally { forgetProject(); }
});
