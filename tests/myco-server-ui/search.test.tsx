import { afterEach, expect, it } from 'bun:test';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SearchCommand, SearchTrigger, useSearchShortcut } from '../../packages/myco-server/ui/src/design';
import { planPath } from '../../packages/myco-server/ui/src/hooks/use-plans';
import { searchResultPath, type SearchResult } from '../../packages/myco-server/ui/src/hooks/use-search';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const hit = (overrides: Partial<SearchResult> = {}): SearchResult => ({ id: 'sp', type: 'spore', title: 'Cache decision', preview: 'Use a bounded cache.', score: 1, ...overrides });
const answer = (results: SearchResult[], pending = 0) => Response.json({ results, mode: 'fts', provider_unavailable: true, coverage: { pending_blobs: pending } });
function Location() { return <output data-testid="location">{useLocation().pathname}{useLocation().search}</output>; }

/** The shell's wiring in small: a trigger, the shortcut, and the command keyed by the project it searches. */
function Harness({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  useSearchShortcut(() => setOpen((value) => !value));
  return (
    <>
      <SearchTrigger onOpen={() => setOpen(true)} />
      <SearchCommand key={project} open={open} onOpenChange={setOpen} project={{ projectId: project, name: project }} />
    </>
  );
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (project: string) => <QueryClientProvider client={client}><MemoryRouter><Harness project={project} /><Location /></MemoryRouter></QueryClientProvider>;
  const rendered = render(tree('one'));
  return { ...rendered, project: (name: string) => rendered.rerender(tree(name)) };
}

/** Opens a design-system select, found by the start of its name, and picks one option. */
async function pick(label: string, option: string) {
  const proto = window.Element.prototype as unknown as { scrollIntoView?: () => void };
  proto.scrollIntoView ??= () => undefined;
  const [trigger] = screen.queryAllByRole('combobox', { name: label }).concat(screen.queryAllByRole('button', { name: new RegExp(`^${label}:`) }));
  fireEvent.click(trigger!);
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

it('debounces, applies facets, opens a result by keyboard and exposes indexing coverage', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (path: string) => { asked.push(new URL(path, 'https://s')); return answer([hit()], 2); }) as typeof fetch;
  mount();
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = await screen.findByRole('searchbox', { name: 'Search this project' });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: 'c' } });
  expect(asked).toHaveLength(0);
  fireEvent.change(input, { target: { value: 'cache' } });
  await screen.findByRole('link', { name: /Cache decision/ });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.pathname).toBe('/api/projects/one/search');
  expect(asked[0]!.searchParams.get('mode')).toBe('auto');
  await pick('Search mode', 'Full text');
  await waitFor(() => expect(asked.at(-1)!.searchParams.get('mode')).toBe('fts'));
  expect(await screen.findByText(/Indexing 2 captured bodies/)).toBeDefined();
  await pick('Result type', 'Spores');
  await pick('Spore type', 'Bug Fix');
  await waitFor(() => expect(asked.at(-1)!.searchParams.get('observation_type')).toBe('bug_fix'));
  await screen.findByRole('link', { name: /Cache decision/ });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement?.tagName).toBe('A');
  fireEvent.click(screen.getByRole('link', { name: /Cache decision/ }));
  expect(screen.getByTestId('location').textContent).toBe('/p/one/spores/sp');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('leads each result with what it says, and names its kind in a word', async () => {
  globalThis.fetch = (async () => answer([hit({ type: 'plan', id: 'p1', session_id: 's1', title: 'Ship the shell', preview: 'Sidebar, filter, search.' })])) as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'shell' } });
  const link = await screen.findByRole('link', { name: /Ship the shell/ });
  expect(link.textContent).toBe('Ship the shellPlanSidebar, filter, search.');
});

it('leads a prompt or response, titled only by its kind, with what it says', async () => {
  globalThis.fetch = (async () => answer([hit({ type: 'prompt', id: 't1', session_id: 's1', prompt_id: 't1', title: 'Prompt', preview: 'Run the parity scenarios' })])) as typeof fetch;
  mount();
  fireEvent.click(screen.getByRole('button', { name: /Search/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'parity' } });
  const link = await screen.findByRole('link', { name: /Run the parity scenarios/ });
  expect(link.textContent).toBe('Run the parity scenariosPrompt');
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
  await screen.findByRole('link', { name: /Cache decision/ });
  fireEvent.change(input, { target: { value: 'second' } });
  expect(screen.queryByRole('link')).toBeNull();
  await waitFor(() => expect(finish).toBeDefined());
  view.project('two');
  finish!(answer([hit({ title: 'Private to one' })]));
  expect((await screen.findByRole('searchbox') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('dialog').textContent).toContain('Search two');
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

it('links captured plans and responses to the corresponding session detail, and gives a skill hit no link at all', () => {
  // Read through the shared destination, so the search hit and the project
  // overview's panel cannot drift to two different URLs for the same plan.
  expect(searchResultPath('a/b', hit({ type: 'plan', id: 'p&1', session_id: 's' })))
    .toBe(planPath('a/b', { planKey: 'p&1', sessionId: 's' }));
  expect(searchResultPath('a/b', hit({ type: 'plan', id: 'p&1', session_id: 's' }))).toBe('/p/a%2Fb/sessions/s?tab=plans&plan=p%261');
  expect(searchResultPath('p', hit({ type: 'response', session_id: 's', prompt_id: 'turn' }))).toBe('/p/p/sessions/s?turn=turn');
  // A skill is read from the catalogue Myco ships rather than from a page here, so the hit shows and does not link.
  expect(searchResultPath('p', hit({ type: 'skill', id: 'skill' }))).toBeNull();
});

it('opens on ⌘K and Ctrl K from every page, a server page searching the project last opened (or the most recent)', async () => {
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
    for (const [remembered, expected, key] of [['two', 'Search Project two', { metaKey: true }], [null, 'Search Project one', { ctrlKey: true }]] as const) {
      if (remembered === null) forgetProject(); else rememberProject(remembered);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={['/measures']}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
      await screen.findByRole('button', { name: /Search/ });
      fireEvent.keyDown(document, { key: 'k', ...key });
      expect((await screen.findByRole('dialog')).textContent).toContain(expected);
      fireEvent.keyDown(document, { key: 'k', ...key });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      cleanup();
    }
  } finally { forgetProject(); }
});
