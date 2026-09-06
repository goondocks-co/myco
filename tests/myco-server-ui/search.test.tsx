import { afterEach, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GlobalSearch } from '../../packages/myco-server/ui/src/components/GlobalSearch';
import { searchResultPath, type SearchResult } from '../../packages/myco-server/ui/src/hooks/use-search';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const hit = (overrides: Partial<SearchResult> = {}): SearchResult => ({ id: 'sp', type: 'spore', title: 'Cache decision', preview: 'Use a bounded cache.', score: 1, ...overrides });
const answer = (results: SearchResult[], pending = 0) => Response.json({ results, mode: 'fts', provider_unavailable: true, coverage: { pending_blobs: pending } });
function Location() { return <output data-testid="location">{useLocation().pathname}{useLocation().search}</output>; }
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (project: string) => <QueryClientProvider client={client}><MemoryRouter><GlobalSearch key={project} projectId={project} projectName={project} /><Location /></MemoryRouter></QueryClientProvider>;
  const rendered = render(tree('one'));
  return { ...rendered, project: (name: string) => rendered.rerender(tree(name)) };
}

it('debounces, applies facets, opens a result by keyboard and exposes indexing coverage', async () => {
  const asked: URL[] = [];
  globalThis.fetch = (async (path: string) => { asked.push(new URL(path, 'https://s')); return answer([hit()], 2); }) as typeof fetch;
  mount();
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const input = await screen.findByRole('searchbox', { name: 'Search project' });
  fireEvent.change(input, { target: { value: 'c' } });
  expect(asked).toHaveLength(0);
  fireEvent.change(input, { target: { value: 'cache' } });
  await screen.findByRole('link', { name: /Cache decision/ });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.pathname).toBe('/api/projects/one/search');
  expect(asked[0]!.searchParams.get('mode')).toBe('auto');
  fireEvent.change(screen.getByLabelText('Search mode'), { target: { value: 'fts' } });
  await waitFor(() => expect(asked.at(-1)!.searchParams.get('mode')).toBe('fts'));
  expect(await screen.findByText(/Indexing 2 captured bodies/)).toBeDefined();
  fireEvent.change(screen.getByLabelText('Result type'), { target: { value: 'spore' } });
  fireEvent.change(screen.getByLabelText('Spore type'), { target: { value: 'bug_fix' } });
  await waitFor(() => expect(asked.at(-1)!.searchParams.get('observation_type')).toBe('bug_fix'));
  await screen.findByRole('link', { name: /Cache decision/ });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(document.activeElement?.tagName).toBe('A');
  fireEvent.click(screen.getByRole('link', { name: /Cache decision/ }));
  expect(screen.getByTestId('location').textContent).toBe('/p/one/spores/sp');
  expect(screen.queryByRole('dialog')).toBeNull();
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
  fireEvent.keyDown(document, { key: 'k', metaKey: true });
  expect((await screen.findByRole('searchbox') as HTMLInputElement).value).toBe('');
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

it('links captured plans and responses to the corresponding session detail', () => {
  expect(searchResultPath('a/b', hit({ type: 'plan', id: 'p&1', session_id: 's' }))).toBe('/p/a%2Fb/sessions/s?tab=plans&plan=p%261');
  expect(searchResultPath('p', hit({ type: 'response', session_id: 's', prompt_id: 'turn' }))).toBe('/p/p/sessions/s?turn=turn');
  expect(searchResultPath('p', hit({ type: 'skill', id: 'skill' }))).toBe('/p/p/skills/skill');
});
