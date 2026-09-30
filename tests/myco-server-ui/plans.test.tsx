/**
 * Knowledge's plans: the board by status across every project and within one,
 * searching it, paging a column, a plan's own page with the session that wrote
 * it and an admin's status control, and the old addresses of a plan.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { planPagePath } from '../../packages/myco-server/ui/src/hooks/use-knowledge';
import { progressParts, progressWords } from '../../packages/myco-server/ui/src/features/knowledge/words';
import { rawIdsIn } from '../helpers/raw-ids';

const HOUR = 3_600_000;
/** Tuesday, September 29 2026, 16:00 local. */
const NOW = new Date(2026, 8, 29, 16, 0, 0).getTime();

const ADMIN = { sub: '1', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '2', login: 'lin', member: { id: 'mem_Hn5pC0dJfA9sEu', label: 'Lin', role: 'member' as const } };
const MYCO = 'proj_6d79636f3a3e1c0b';
const LEDGER = 'proj_1ed9e40c5b6a7f8e';
const PROJECTS = { projects: [
  { projectId: MYCO, name: 'Myco', createdAt: 0, sessionCount: 3, lastActivityAt: NOW },
  { projectId: LEDGER, name: 'Ledger service', createdAt: 0, sessionCount: 1, lastActivityAt: NOW - HOUR },
] };
const MEMBERS = { members: [
  { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
] };
const KEY = '11111111-2222-4333-8444-555555555555';

const plan = (over: Record<string, unknown> = {}) => ({
  projectId: MYCO, planKey: KEY, sessionId: 's1', promptId: 'p1', title: 'Myco’s work as outcomes', status: 'in_progress',
  content: '# Myco’s work as outcomes\n\n- [x] Group runs by task\n- [ ] Fold index upkeep into one line', blobKey: null, objectKey: null, originPath: 'docs/plans/work-outcomes.md',
  progress: '1/2', updatedBy: null, createdAt: NOW - 3 * HOUR, updatedAt: NOW - HOUR, tags: ['ui'], ...over,
});
const board = (plans: unknown[], cursor: string | null = null) => Response.json({ plans, cursor, maxPage: 200 });
const EMPTY = () => board([]);

const originalFetch = globalThis.fetch;
(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;
beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; setSystemTime(); forgetProject(); });

type Routes = Record<string, (init?: RequestInit) => Response | Promise<Response>>;
interface Sent { method: string; path: string; body: unknown }

function server(routes: Routes): { requested: string[]; sent: Sent[] } {
  const requested: string[] = [];
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    if ((init?.method ?? 'GET') !== 'GET') sent.push({ method: init!.method!, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes[url.pathname + url.search]?.(init) ?? routes[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested, sent };
}

const columns = (project = '', over: Record<string, () => Response> = {}): Routes => Object.fromEntries(
  ['in_progress', 'active', 'completed', 'abandoned'].map((status) => [`/api/plans?status=${status}&limit=8${project}`, over[status] ?? EMPTY]),
);

const base = (extra: Routes = {}, me: unknown = ADMIN): Routes => ({
  '/auth/me': () => Response.json(me),
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
const column = (status: string) => document.querySelector(`[data-plan-column="${status}"]`) as HTMLElement;

/** Visible text carrying a raw id, outside the facts panel and the test's own location probe. */
const rawIdsInPage = (): string[] => rawIdsIn(document.body, ['[data-testid="location"]']);

describe('the plans board', () => {
  it('lays out every status as a column, each plan leading to its page and to the session that wrote it', async () => {
    const { requested } = server(base(columns('', {
      in_progress: () => board([plan()]),
      active: () => board([plan({ planKey: '22222222-2222-4333-8444-555555555555', title: 'One filter bar on every list page', status: 'active', progress: 'N/A' })]),
      completed: () => board([plan({ projectId: LEDGER, planKey: '33333333-2222-4333-8444-555555555555', sessionId: 's9', title: 'Speed up the monthly close report', status: 'completed', progress: '3/3' })]),
      abandoned: () => board([plan({ planKey: '44444444-2222-4333-8444-555555555555', title: null, status: 'abandoned', progress: 'N/A' })]),
    })));
    mount('/knowledge/plans');
    await waitFor(() => expect(document.querySelectorAll('[data-plan]')).toHaveLength(4));
    const headings = [...document.querySelectorAll('[data-plan-column] h2')].map((h) => h.textContent);
    expect(headings).toEqual(['In progress', 'Open', 'Done', 'Abandoned']);
    for (const status of ['in_progress', 'active', 'completed', 'abandoned']) expect(requested).toContain(`/api/plans?status=${status}&limit=8`);
    const card = within(column('in_progress')).getByRole('link', { name: 'Myco’s work as outcomes' });
    expect(card.getAttribute('href')).toBe(`/p/${MYCO}/plans/${KEY}?session=s1`);
    expect(column('in_progress').textContent).toContain('1 of 2 items done');
    expect(column('in_progress').textContent).toContain('Myco');
    expect(column('in_progress').textContent).toContain('updated 1 h ago');
    expect(within(column('in_progress')).getByRole('meter', { name: 'Plan items done' }).getAttribute('aria-valuenow')).toBe('1');
    expect(within(column('in_progress')).getByRole('link', { name: 'The session that wrote “Myco’s work as outcomes”' }).getAttribute('href')).toBe(`/p/${MYCO}/sessions/s1`);
    expect(column('completed').textContent).toContain('Ledger service');
    expect(within(column('abandoned')).getByRole('link', { name: 'Untitled plan' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Knowledge sections' })).getByRole('link', { name: 'Plans' }).getAttribute('aria-current')).toBe('page');
    expect(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Knowledge' }).getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('[data-filter-bar]')).toHaveLength(1);
    expect(rawIdsInPage()).toEqual([]);
  });

  it('reads the next page of one column from its cursor, and says when a column is empty', async () => {
    const first = Array.from({ length: 8 }, (_, i) => plan({ planKey: `k${i}`, title: `Plan ${i}` }));
    const { requested } = server(base({
      ...columns('', { in_progress: () => board(first, 'c1') }),
      '/api/plans?status=in_progress&limit=8&cursor=c1': () => board([plan({ planKey: 'k9', title: 'Plan nine' })]),
    }));
    mount('/knowledge/plans');
    await waitFor(() => expect(column('in_progress').querySelectorAll('[data-plan]')).toHaveLength(8));
    expect(column('active').textContent).toContain('No open plans.');
    fireEvent.click(within(column('in_progress')).getByRole('button', { name: 'Show more' }));
    await asked(requested, '/api/plans?status=in_progress&limit=8&cursor=c1');
    await waitFor(() => expect(column('in_progress').querySelectorAll('[data-plan]')).toHaveLength(9));
    expect(within(column('in_progress')).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('searches every column by words, keeping the board, and keeps the search in the URL', async () => {
    const hit = (status: string, id: string, title: string) => ({ projectId: MYCO, id, type: 'plan', title, preview: `${title}: group runs by task.`, score: 1, session_id: 's1' });
    const { requested } = server(base({
      ...columns(),
      '/api/search?q=runs&type=plan&status=in_progress&limit=20': () => Response.json({ results: [hit('in_progress', KEY, 'Myco’s work as outcomes')], mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } }),
      '/api/search?q=runs&type=plan&status=active&limit=20': () => Response.json({ results: [], mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } }),
      '/api/search?q=runs&type=plan&status=completed&limit=20': () => Response.json({ results: [], mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } }),
      '/api/search?q=runs&type=plan&status=abandoned&limit=20': () => Response.json({ results: [], mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } }),
    }));
    mount('/knowledge/plans');
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search plans' }), { target: { value: 'runs' } });
    for (const status of ['in_progress', 'active', 'completed', 'abandoned']) await asked(requested, `/api/search?q=runs&type=plan&status=${status}&limit=20`);
    const found = await within(column('in_progress')).findByRole('link', { name: 'Myco’s work as outcomes' });
    expect(found.getAttribute('href')).toBe(`/p/${MYCO}/plans/${KEY}?session=s1`);
    expect(column('in_progress').textContent).toContain('group runs by task');
    expect(column('active').textContent).toContain('None match.');
    expect(column('in_progress').querySelector('[data-cap-note]')).toBeNull();
    expect(location()).toBe('/knowledge/plans?q=runs');
  });

  it('narrows to one project, which the cards then leave out', async () => {
    const { requested } = server(base(columns(`&project=${MYCO}`, { in_progress: () => board([plan()]) })));
    mount(`/p/${MYCO}/knowledge/plans`);
    await waitFor(() => expect(document.querySelectorAll('[data-plan]')).toHaveLength(1));
    expect(requested).toContain(`/api/plans?status=in_progress&limit=8&project=${MYCO}`);
    expect(column('in_progress').textContent).not.toContain('Myco ·');
  });

  it('sends the old plans list to the board under the same project', async () => {
    server(base(columns(`&project=${MYCO}`)));
    mount(`/p/${MYCO}/plans?status=completed`);
    await waitFor(() => expect(location()).toBe(`/p/${MYCO}/knowledge/plans?status=completed`));
  });
});

it('says when a column’s search reached the cap', async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ projectId: MYCO, id: `${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`, type: 'plan', title: `Plan ${i}`, preview: 'runs', score: 1, session_id: 's1' }));
  const none = () => Response.json({ results: [], mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } });
  server(base({
    ...columns(),
    '/api/search?q=runs&type=plan&status=in_progress&limit=20': () => Response.json({ results: many, mode: 'fts', provider_unavailable: false, coverage: { pending_blobs: 0 } }),
    '/api/search?q=runs&type=plan&status=active&limit=20': none,
    '/api/search?q=runs&type=plan&status=completed&limit=20': none,
    '/api/search?q=runs&type=plan&status=abandoned&limit=20': none,
  }));
  mount('/knowledge/plans?q=runs');
  await waitFor(() => expect(column('in_progress').querySelectorAll('[data-plan]')).toHaveLength(20));
  expect(column('in_progress').querySelector('[data-cap-note]')!.textContent).toBe('The 20 best matches. Add words or a filter to narrow them.');
  expect(rawIdsInPage()).toEqual([]);
});

describe('a plan’s page', () => {
  const sessionPlans = (over: Record<string, unknown> = {}) => Response.json({ rows: [{ ...plan(over), orderedAt: NOW }], cursor: null });
  const sessionAnswer = () => Response.json({
    session: { projectId: MYCO, sessionId: 's1', agent: 'claude-code', title: 'Work outcomes counted per task', label: 's1', summary: null, startedAt: NOW - 4 * HOUR, firstReceivedAt: NOW - 4 * HOUR, lastReceivedAt: NOW - 3 * HOUR, endedAt: NOW - 3 * HOUR, memberId: null, memberLabel: null, runtimeLabel: null, branch: null, originPath: null, parentSessionId: null, parentReason: null, endedBy: null, endedByLabel: null },
    untitled: null, counts: { prompts: 3, toolCalls: 0, responses: 3, plans: 1, attachments: 0 }, release: null, outcome: { runs: [], spores: { total: 0, items: [] } }, projectId: MYCO,
  });

  it('reads the plan through the session a link names: its status, progress, the plan in full, the session that wrote it and the facts', async () => {
    const { requested } = server(base({
      [`/api/projects/${MYCO}/sessions/s1/plans?limit=100`]: () => sessionPlans({ updatedBy: 'mem_q3Vb8xRk2LmT7wYz' }),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
    }));
    mount(planPagePath(MYCO, { planKey: KEY, sessionId: 's1' }));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Myco’s work as outcomes');
    const page = document.querySelector('[data-plan-page]') as HTMLElement;
    expect(page.querySelector('[data-plan-status]')!.textContent).toBe('In progress');
    expect(page.querySelector('[data-plan-progress]')!.textContent).toContain('1 of 2 items done');
    const body = page.querySelector('[data-plan-body]') as HTMLElement;
    expect(body.textContent).toContain('Fold index upkeep into one line');
    // The plan's own heading repeats the title the page shows, so it is left out.
    expect(body.textContent).not.toContain('Myco’s work as outcomes');
    // A task keeps its words as its name, and says whether it is done.
    const tasks = within(body).getAllByRole('listitem');
    expect(tasks.map((li) => [li.getAttribute('data-task'), li.textContent])).toEqual([['done', 'Done: Group runs by task'], ['open', 'To do: Fold index upkeep into one line']]);
    expect(within(body).queryAllByRole('checkbox')).toEqual([]);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Knowledge', `/p/${MYCO}/knowledge`], ['Plans', `/p/${MYCO}/knowledge/plans`], ['Myco', `/p/${MYCO}`],
    ]);
    const written = page.querySelector('[data-plan-session]') as HTMLElement;
    expect(await within(written).findByText('Work outcomes counted per task')).toBeTruthy();
    expect(within(written).getByRole('link', { name: 'Open the session →' }).getAttribute('href')).toBe(`/p/${MYCO}/sessions/s1`);
    expect(within(written).getByRole('link', { name: 'The turn it came from →' }).getAttribute('href')).toBe(`/p/${MYCO}/sessions/s1?turn=p1`);
    const facts = page.querySelector('[data-facts]') as HTMLElement;
    expect(facts.textContent).toContain('docs/plans/work-outcomes.md');
    expect(facts.textContent).toContain('Status set byAda');
    expect(within(facts).getByRole('button', { name: 'Copy plan key' })).toBeTruthy();
    expect(requested.some((path) => path.startsWith(`/api/projects/${MYCO}/plans`))).toBe(false);
    expect(rawIdsInPage()).toEqual([]);
  });

  it('lets an admin pick a status and save it through the session’s route, then shows the saved status', async () => {
    let status = 'in_progress';
    const { sent } = server(base({
      [`/api/projects/${MYCO}/sessions/s1/plans?limit=100`]: () => sessionPlans({ status }),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
      [`/api/projects/${MYCO}/sessions/s1/plans/${KEY}/status`]: () => { status = 'completed'; return Response.json({ plan: plan({ status }) }); },
    }));
    mount(planPagePath(MYCO, { planKey: KEY, sessionId: 's1' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Plan status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Done' }));
    // Picking writes nothing; the save does.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save status' }));
    await waitFor(() => expect(sent).toEqual([{ method: 'POST', path: `/api/projects/${MYCO}/sessions/s1/plans/${KEY}/status`, body: { status: 'completed' } }]));
    await waitFor(() => expect(document.querySelector('[data-plan-status]')!.textContent).toBe('Done'));
    expect(screen.queryByRole('button', { name: 'Save status' })).toBeNull();
  });

  it('puts a picked status back on Cancel, writing nothing', async () => {
    const { sent } = server(base({
      [`/api/projects/${MYCO}/sessions/s1/plans?limit=100`]: () => sessionPlans(),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
    }));
    mount(planPagePath(MYCO, { planKey: KEY, sessionId: 's1' }));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Plan status' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Abandoned' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('combobox', { name: 'Plan status' }).textContent).toBe('In progress');
    expect(sent).toEqual([]);
  });

  it('shows a member the status in a word, with no control', async () => {
    server(base({
      [`/api/projects/${MYCO}/sessions/s1/plans?limit=100`]: () => sessionPlans(),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
    }, MEMBER));
    mount(planPagePath(MYCO, { planKey: KEY, sessionId: 's1' }));
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('combobox', { name: 'Plan status' })).toBeNull();
    expect((document.querySelector('[data-facts]') as HTMLElement).textContent).toContain('StatusIn progress');
  });

  it('finds a plan a link names without its session by reading the project’s plans a page at a time', async () => {
    const { requested } = server(base({
      [`/api/projects/${MYCO}/plans?limit=200`]: () => board([plan({ planKey: 'other' })], 'c1'),
      [`/api/projects/${MYCO}/plans?limit=200&cursor=c1`]: () => board([plan()]),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
    }));
    mount(`/p/${MYCO}/plans/${KEY}`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Myco’s work as outcomes');
    expect(requested).toContain(`/api/projects/${MYCO}/plans?limit=200&cursor=c1`);
  });

  it('says not found for a plan the project does not hold', async () => {
    server(base({ [`/api/projects/${MYCO}/plans?limit=200`]: () => board([]) }));
    mount(`/p/${MYCO}/plans/${KEY}`);
    expect(await screen.findByText('Not found')).toBeTruthy();
  });

  it('opens from a session’s old plan link', async () => {
    server(base({
      [`/api/projects/${MYCO}/sessions/s1/plans?limit=100`]: () => sessionPlans(),
      [`/api/projects/${MYCO}/sessions/s1`]: sessionAnswer,
    }));
    mount(`/p/${MYCO}/sessions/s1?tab=plans&plan=${KEY}`);
    await waitFor(() => expect(location()).toBe(`/p/${MYCO}/plans/${KEY}?session=s1`));
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Myco’s work as outcomes');
  });
});

describe('the plan words', () => {
  it('reads progress only from a task list', () => {
    expect([progressParts('1/2'), progressParts('0/0'), progressParts('N/A')]).toEqual([{ checked: 1, total: 2 }, null, null]);
    expect([progressWords('3/3'), progressWords('0/1'), progressWords('N/A')]).toEqual(['3 of 3 items done', '0 of 1 item done', null]);
  });
});
