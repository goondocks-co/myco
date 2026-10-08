/**
 * Sessions: the table across every project and within one, and a session's
 * reading page with what came of it, its conversation, its tabs, its raw data
 * and an admin's actions.
 *
 * The clock is held at a fixed afternoon so every instant below sits on the day
 * it names, whatever the machine's own time.
 */
import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { LIVE_REFRESH_MS } from '../../packages/myco-server/ui/src/hooks/use-work';
import { sessionListPath } from '../../packages/myco-server/ui/src/hooks/use-sessions';
import { promptPreview, PROMPT_PREVIEW_CHARS } from '../../packages/myco-server/ui/src/features/sessions/Turn';
import { memberFilter, startedWords, windowBounds } from '../../packages/myco-server/ui/src/features/sessions/words';
import { LIVE_WITHIN_MS } from '../../packages/myco-server/ui/src/features/today/timeline';
import { rawIdsIn } from '../helpers/raw-ids';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Tuesday, September 29 2026, 16:00 local. */
const NOW = new Date(2026, 8, 29, 16, 0, 0).getTime();
const TODAY = new Date(2026, 8, 29).getTime();


const ADMIN = { sub: '1', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '2', login: 'lin', member: { id: 'mem_Hn5pC0dJfA9sEu', label: 'Lin', role: 'member' as const } };
const PROJECTS = { projects: [
  { projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 3, lastActivityAt: NOW },
  { projectId: 'y', name: 'Atlas web', createdAt: 0, sessionCount: 1, lastActivityAt: NOW - HOUR },
] };
const MEMBERS = { members: [
  { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  // Joined without a name: the label is only the id, so the filter cannot offer this member without showing it.
  { id: 'mem_Hn5pC0dJfA9sEu', label: 'mem_Hn5pC0dJfA9sEu', role: 'member', linked: true, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 1 },
  { id: 'mem_harness', label: 'harness', role: 'admin', linked: false, createdAt: 0, revokedAt: null, revokedBy: null, liveCredentials: 0 },
] };

const KEY_TEXT = 'a'.repeat(64);
const KEY_IMG = 'b'.repeat(64);
const KEY_SVG = 'c'.repeat(64);
const KEY_SEG = 'd'.repeat(64);
const BLOB = (key: string) => `/api/projects/x/blobs/${key}?raw=71`;
const P1 = '00000000-0000-7000-8000-000000000001';
const P2 = '00000000-0000-7000-8000-000000000002';
const P3 = '00000000-0000-7000-8000-000000000003';

/** A session as the server serves it: listed across projects, or read on its own. */
const session = (over: Record<string, unknown> = {}) => ({
  projectId: 'x', sessionId: 's1', machineId: 'mac-1', createdByTokenId: 'mt_0123456789abcdef', firstReceivedAt: NOW - HOUR, lastReceivedAt: NOW - MINUTE,
  agent: 'claude-code', branch: 'main', startedAt: NOW - HOUR, endedAt: null, endedBy: null, endedByLabel: null, originPath: '/repo', parentSessionId: null, parentReason: null,
  memberId: 'mem_q3Vb8xRk2LmT7wYz', memberLabel: 'Ada', runtimeLabel: 'Ada’s studio Mac', runtimeKind: 'cli',
  title: null, summary: null, titledAt: null, label: 's1', promptCount: 2, toolCallCount: 3, activityBuckets: [1, 0, 0, 0, 0, 0, 0, 1],
  ...over,
});
const page = (rows: unknown[], cursor: string | null = null) => Response.json({ rows, cursor });
const counts = { prompts: 2, toolCalls: 3, responses: 1, plans: 0, attachments: 2 };
const NO_OUTCOME = { runs: [], spores: { total: 0, items: [] } };
const detail = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  Response.json({ session: session(over), untitled: null, counts, release: null, outcome: NO_OUTCOME, projectId: 'x', ...extra });

const turn = (over: Record<string, unknown> = {}) => ({
  promptId: P1, origin: 'user', promptKind: null, threadLabel: null, preview: 'Please rename the project card', textChars: 30, blobKey: null,
  createdAt: NOW - 3000, toolCallCount: 1, responseCount: 1, childCount: 0, planCount: 0, attachmentCount: 0, ...over,
});

const originalFetch = globalThis.fetch;
// jsdom lays nothing out, so it has no scrollIntoView; Radix's select calls it as it opens.
(window.Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => undefined;
beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; setSystemTime(); forgetProject(); });

type Routes = Record<string, (init?: RequestInit) => Response | Promise<Response>>;

/** Answers a path with its query first, then the path alone; anything else is 404. Records every request. */
function server(routes: Routes): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    return routes[url.pathname + url.search]?.(init) ?? routes[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

const base = (extra: Routes = {}, me: unknown = ADMIN): Routes => ({
  '/auth/me': () => Response.json(dashboardMe(me)),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  ...extra,
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function mount(path: string, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><LocationProbe /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  return client;
}

const location = () => screen.getByTestId('location').textContent;

/** Opens a design-system select by its label and picks one option, the way a person does. */
async function pick(label: string, option: string) {
  fireEvent.click(await screen.findByRole('combobox', { name: label }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

/** The agent filter lists more than eight agents, so it is the searchable select: a button naming its value, then a search over the list. */
async function pickAgent(option: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^Agent: / }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Search agent' }), { target: { value: option } });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}

/** The table's column headings, without the day headings that head each group. */
const columnHeadings = (table: HTMLElement) => within(within(table).getAllByRole('rowgroup')[0]!).getAllByRole('columnheader').map((th) => th.textContent);

/** Visible text carrying a raw id, outside the facts panel and the test's own location probe. */
const rawIdsInPage = (): string[] => rawIdsIn(document.body, ['[data-testid="location"]']);

const listPath = (filters: Parameters<typeof sessionListPath>[0]) => sessionListPath(filters);

describe('the sessions table', () => {
  const LIVE = session({ sessionId: 's1', label: 'Run the parity scenarios', lastReceivedAt: NOW - MINUTE, startedAt: NOW - 42 * MINUTE });
  /** Live now and started the evening before: live sessions older than the first page still show, on top. */
  const LIVE_SINCE_YESTERDAY = session({ sessionId: 's0', projectId: 'y', title: 'Overnight migration', label: 'Overnight migration', startedAt: TODAY - 2 * HOUR - 20 * MINUTE, firstReceivedAt: TODAY - 2 * HOUR - 20 * MINUTE, lastReceivedAt: NOW - 2 * MINUTE });
  const ROWS = [
    LIVE,
    session({ sessionId: 's2', projectId: 'y', agent: 'codex', title: 'Checkout errors name their field', summary: 'Replaced the generic errors.\nAdded tests.', label: 'Checkout errors name their field', startedAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR, promptCount: 12 }),
    session({ sessionId: 's3', agent: 'cursor', title: null, label: 's3', startedAt: NOW - DAY - HOUR, endedAt: NOW - DAY, memberId: 'mem_harness', memberLabel: 'harness', promptCount: 1 }),
  ];
  /** The live group's read: open sessions heard from within the live span, under the same filters. */
  const livePath = (filters: Omit<Parameters<typeof sessionListPath>[0], 'state' | 'active'>) => sessionListPath({ ...filters, state: 'open', active: { since: NOW - LIVE_WITHIN_MS } });

  it('lists every project’s sessions at /sessions: the live ones pinned on top, the rest under the day each started, each row opening its session', async () => {
    const { requested } = server(base({
      [listPath({ projectId: null })]: () => page(ROWS),
      [livePath({ projectId: null })]: () => page([LIVE, LIVE_SINCE_YESTERDAY]),
    }));
    mount('/sessions');
    const table = await screen.findByRole('table', { name: 'Sessions' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Sessions');
    expect(screen.getByText('Every session your agents ran.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Showing: All projects' })).toBeTruthy();
    expect(columnHeadings(table)).toEqual(['Session', 'Project', 'Agent', 'Size', 'Started']);
    await waitFor(() => expect(within(table).getAllByRole('rowgroup').slice(1).map((g) => within(g).getAllByRole('row')[0]!.textContent)).toEqual(['Live now', 'Today', 'Yesterday']));
    const groups = within(table).getAllByRole('rowgroup').slice(1);
    const [live, overnight] = within(groups[0]!).getAllByRole('row').slice(1);
    // Live rows carry the chip and their real start; one begun yesterday says since when.
    expect(live!.getAttribute('data-live')).toBe('');
    expect(within(live!).getByRole('link').textContent).toBe('LiveUntitledRun the parity scenarios');
    expect(within(live!).getByRole('link').getAttribute('href')).toBe('/p/x/sessions/s1');
    expect(within(live!).getByRole('time').textContent).toBe('15:18');
    expect(within(overnight!).getByRole('time').textContent).toBe('since yesterday 21:40');
    expect(within(table).getAllByRole('time').map((t) => t.textContent)).not.toContain('now');
    // A live row is listed once, in the live group, even when the day's page holds it too.
    expect(within(table).getAllByRole('link', { name: /Run the parity scenarios/ })).toHaveLength(1);
    const ended = within(groups[1]!).getAllByRole('row')[1]!;
    expect(ended.getAttribute('data-live')).toBeNull();
    expect(within(ended).getByRole('link').getAttribute('href')).toBe('/p/y/sessions/s2');
    for (const words of ['Atlas web', 'Codex', '12 prompts', '11:00', 'Replaced the generic errors. Added tests.']) expect(ended.textContent).toContain(words);
    const untitled = within(groups[2]!).getAllByRole('row')[1]!;
    expect(untitled.textContent).toContain('Untitled session');
    expect(untitled.textContent).toContain('Cursor');
    expect(screen.getByText('Showing 4 sessions')).toBeTruthy();
    expect(requested).toContain(listPath({ projectId: null }));
    expect(requested).toContain(livePath({ projectId: null }));
    expect(rawIdsInPage()).toEqual([]);
  });

  it('narrows to one project at /p/:project/sessions, without a Project column, and says which', async () => {
    const { requested } = server(base({ '/api/sessions': () => page([ROWS[0]]) }));
    mount('/p/x/sessions');
    const table = await screen.findByRole('table', { name: 'Sessions' });
    expect(columnHeadings(table)).toEqual(['Session', 'Agent', 'Size', 'Started']);
    expect(screen.getByText('Every session your agents ran.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Showing: Project X' })).toBeTruthy());
    expect(requested).toContain('/api/sessions?limit=50&project=x');
    expect(requested).toContain(livePath({ projectId: 'x' }));
  });

  it('asks the server for each filter from the bar, holds them in the URL, and Clear drops them all at once', async () => {
    const { requested } = server(base({ '/api/sessions': () => page(ROWS) }));
    mount('/p/x/sessions');
    await screen.findByRole('table', { name: 'Sessions' });
    const bar = document.querySelector('[data-filter-bar]') as HTMLElement;
    expect(document.querySelectorAll('[data-filter-bar]')).toHaveLength(1);
    // The closed controls show their short words; the lists say them in full.
    expect(within(bar).getByRole('button', { name: 'Agent: Any agent' }).textContent).toBe('Agent');
    expect(within(bar).getAllByRole('combobox').map((c) => [c.getAttribute('aria-label'), c.textContent])).toEqual([['Member', 'Member'], ['State', 'State'], ['Active', 'Active: any time']]);

    await pickAgent('Codex');
    await waitFor(() => expect(location()).toBe('/p/x/sessions?agent=codex'));
    await waitFor(() => expect(requested).toContain(listPath({ projectId: 'x', agent: 'codex' })));

    // Members are offered by name; one known only by an id is left out, and Myco's own account reads "Myco".
    fireEvent.click(screen.getByRole('combobox', { name: 'Member' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Any member', 'Ada', 'Myco']);
    fireEvent.click(screen.getByRole('option', { name: 'Myco' }));
    await waitFor(() => expect(requested).toContain(listPath({ projectId: 'x', agent: 'codex', member: 'harness' })));

    await pick('State', 'Open');
    // Active today is the sessions running at some point today, whenever they started: the activity window, to tomorrow.
    await pick('Active', 'Active today');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter sessions' }), { target: { value: 'parity' } });
    const everything = listPath({ projectId: 'x', state: 'open', q: 'parity', agent: 'codex', member: 'harness', active: { since: TODAY, until: TODAY + DAY } });
    await waitFor(() => expect(requested).toContain(everything));
    expect(new URL(everything, 'https://s').searchParams.get('window')).toBe('activity');
    expect(new URLSearchParams(location()!.split('?')[1]).toString()).toBe('agent=codex&member=harness&state=open&window=today&q=parity');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    await waitFor(() => expect(location()).toBe('/p/x/sessions'));
    expect((screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement).value).toBe('');
  });

  it('lists a session started yesterday and live now under Active today, saying since when it ran', async () => {
    const path = listPath({ projectId: null, active: { since: TODAY, until: TODAY + DAY } });
    const ENDED_SINCE_YESTERDAY = session({ sessionId: 's9', title: 'Late-night refactor', label: 'Late-night refactor', startedAt: TODAY - HOUR, firstReceivedAt: TODAY - HOUR, lastReceivedAt: TODAY + HOUR, endedAt: TODAY + HOUR });
    server(base({ [path]: () => page([ENDED_SINCE_YESTERDAY, LIVE_SINCE_YESTERDAY]), [livePath({ projectId: null })]: () => page([LIVE_SINCE_YESTERDAY]) }));
    mount('/sessions?window=today');
    const table = await screen.findByRole('table', { name: 'Sessions' });
    await waitFor(() => expect(table.querySelector('[data-live]')).not.toBeNull());
    expect(within(table.querySelector('[data-live]') as HTMLElement).getByRole('time').textContent).toBe('since yesterday 21:40');
    // Grouped by the day it started; the Started cell says it began before the period.
    const ended = within(table).getByRole('link', { name: 'Late-night refactor' }).closest('tr')!;
    expect(within(ended).getByRole('time').textContent).toBe('since yesterday 23:00');
    expect(within(table).getAllByRole('rowgroup').slice(1).map((g) => within(g).getAllByRole('row')[0]!.textContent)).toEqual(['Live now', 'Yesterday']);
  });

  it('reads the filters a link carries, the branch among them, into the bar and the request', async () => {
    const { requested } = server(base({ '/api/sessions': () => page([]) }));
    mount('/sessions?agent=cursor&state=ended&window=week&q=rounding&branch=main');
    await screen.findByText('No sessions match.');
    expect(requested).toContain(listPath({ projectId: null, state: 'ended', q: 'rounding', agent: 'cursor', branch: 'main', active: { since: TODAY - 6 * DAY, until: TODAY + DAY } }));
    // An ended list has no live group to ask for.
    expect(requested.some((p) => p.includes('state=open'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Agent: Cursor' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'State' }).textContent).toBe('Ended');
    expect(screen.getByRole('combobox', { name: 'Active' }).textContent).toBe('Past 7 days');
    expect(document.querySelector('[data-branch-filter]')!.textContent).toContain('main');
    expect((screen.getByRole('searchbox', { name: 'Filter sessions' }) as HTMLInputElement).value).toBe('rounding');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search and filters' }));
    await waitFor(() => expect(location()).toBe('/sessions'));
  });

  it('says a project with no sessions has none yet', async () => {
    server(base({ '/api/sessions': () => page([]) }));
    mount('/p/x/sessions');
    expect(await screen.findByText('No sessions yet. Sessions appear here as your agents capture them.')).toBeTruthy();
  });

  it('answers a project that does not exist with not found', async () => {
    server(base({ '/api/sessions': () => page([]) }));
    mount('/p/nope/sessions');
    expect(await screen.findByText('Not found')).toBeTruthy();
  });

  it('pages with Show more, keeping the search and filters on the next page, and lists a session the order revised onto two pages once', async () => {
    const first = [session({ sessionId: 'a', title: 'session a', startedAt: NOW - 1000, endedAt: NOW }), session({ sessionId: 'b', title: 'session b', startedAt: NOW - 2000, endedAt: NOW })];
    const second = [session({ sessionId: 'b', title: 'session b refined', startedAt: NOW - 4000, endedAt: NOW }), session({ sessionId: 'c', title: 'session c', startedAt: NOW - 5000, endedAt: NOW })];
    const path = listPath({ projectId: 'x', q: 'port', agent: 'codex' });
    const { requested } = server(base({ [path]: () => page(first, 'c1'), [`${path}&cursor=c1`]: () => page(second), '/api/sessions': () => page([]) }));
    mount('/p/x/sessions?q=port&agent=codex');
    expect(await screen.findByText('session a')).toBeTruthy();
    expect(screen.getByText('Showing 2 sessions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(screen.getByText('session c')).toBeTruthy());
    // The next page is the same read with its cursor: the search and the agent ride along.
    const cursorRead = new URL(requested.find((p) => p.includes('cursor=c1'))!, 'https://s').searchParams;
    expect([cursorRead.get('q'), cursorRead.get('agent'), cursorRead.get('project')]).toEqual(['port', 'codex', 'x']);
    expect(screen.queryAllByText('session b')).toHaveLength(0);
    expect(screen.queryAllByText('session b refined')).toHaveLength(1);
    expect(screen.getByText('Showing 3 sessions')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('reads only the live group again every 30 s while it holds a session, never from a hidden tab, and never the pages below', async () => {
    server(base({ '/api/sessions': () => page(ROWS), [livePath({ projectId: 'x' })]: () => page([LIVE]) }));
    const client = mount('/p/x/sessions');
    await waitFor(() => expect(document.querySelector('[data-live]')).not.toBeNull());
    type Polled = { refetchInterval?: number | false | ((q: unknown) => number | false); refetchIntervalInBackground?: boolean };
    const interval = (query: { options: unknown }) => {
      const { refetchInterval } = query.options as Polled;
      return typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval ?? false;
    };
    const live = client.getQueryCache().findAll({ queryKey: ['sessions', 'live'] })[0]!;
    expect((live.options as Polled).refetchIntervalInBackground).toBe(false);
    expect(interval(live)).toBe(LIVE_REFRESH_MS);
    const pages = client.getQueryCache().findAll({ queryKey: ['sessions', 'x'] })[0]!;
    expect(interval(pages)).toBe(false);
    cleanup();

    server(base({ '/api/sessions': () => page(ROWS.slice(1)), [livePath({ projectId: 'x' })]: () => page([]) }));
    const quiet = mount('/p/x/sessions');
    await screen.findByRole('table', { name: 'Sessions' });
    await waitFor(() => expect(quiet.getQueryCache().findAll({ queryKey: ['sessions', 'live'] })[0]!.state.status).toBe('success'));
    expect(interval(quiet.getQueryCache().findAll({ queryKey: ['sessions', 'live'] })[0]!)).toBe(false);
  });

  it('bounds each Active period by day boundaries, to the start of tomorrow, so the request holds still while the day lasts', () => {
    expect([windowBounds('all', NOW), windowBounds('today', NOW), windowBounds('week', NOW), windowBounds('month', NOW)])
      .toEqual([null, { since: TODAY, until: TODAY + DAY }, { since: TODAY - 6 * DAY, until: TODAY + DAY }, { since: TODAY - 29 * DAY, until: TODAY + DAY }]);
    expect(windowBounds('today', NOW + 3 * HOUR)).toEqual({ since: TODAY, until: TODAY + DAY });
    expect([startedWords(NOW - HOUR, TODAY, NOW), startedWords(TODAY - 2 * HOUR - 20 * MINUTE, TODAY, NOW), startedWords(TODAY - 3 * DAY, TODAY, NOW)])
      .toEqual(['15:00', 'since yesterday 21:40', 'since Sep 26, 00:00']);
    // A member named in the URL whom the list does not know is kept, so the bar never drops the pick.
    expect(memberFilter([], 'lin').options.map((o) => o.label)).toEqual(['Any member', 'lin']);
  });
});

describe('the session reading page', () => {
  const OUTCOME = {
    runs: [
      { runId: 'run_a2c4e6f801', task: 'extract-curate', status: 'completed', startedAt: NOW - 50 * MINUTE, completedAt: NOW - 42 * MINUTE, readAt: NOW - 49 * MINUTE, target: false, titled: false, spores: 2 },
      { runId: 'run_4f1c9a2e7b', task: 'extract-curate', status: 'failed', startedAt: NOW - 70 * MINUTE, completedAt: NOW - 64 * MINUTE, readAt: null, target: false, titled: false, spores: 1 },
      { runId: 'run_7d1e2f3b51', task: 'title-summary', status: 'completed', startedAt: NOW - 80 * MINUTE, completedAt: NOW - 79 * MINUTE, readAt: NOW - 80 * MINUTE, target: true, titled: true, spores: 0 },
      { runId: 'run_0ld7171e00', task: 'title-summary', status: 'completed', startedAt: NOW - 3 * DAY, completedAt: NOW - 3 * DAY + MINUTE, readAt: null, target: true, titled: false, spores: 0 },
    ],
    spores: { total: 12, items: [
      { id: 'sp1', observationType: 'gotcha', status: 'active', agentLine: 'A reserved test port races the ephemeral fallback.', sessionId: 's1', createdAt: NOW - 42 * MINUTE, runId: 'run_a2c4e6f801' },
      { id: 'sp2', observationType: 'bug_fix', status: 'active', agentLine: null, sessionId: 's1', createdAt: NOW - 43 * MINUTE, runId: null },
    ] },
  };

  const routes = (over: Routes = {}, me: unknown = ADMIN): Routes => base({
    '/api/projects/x/sessions/s1': () => detail({ title: 'Flaky test port collision fixed', summary: 'The test reserved a fixed port.\nIt now asks the kernel for one.', endedAt: NOW - 20 * MINUTE }, { outcome: OUTCOME, release: { state: 'released', confidence: 'high', ref: 'refs/tags/v1.2.0', reason: null, checkedAt: NOW, latestCheck: null } }),
    '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([
      turn({ promptId: P1, preview: `Please rename the project card ${'x'.repeat(130)}`, textChars: 30_000, toolCallCount: 1, responseCount: 1 }),
      turn({ promptId: P3, preview: null, textChars: null, blobKey: KEY_TEXT, toolCallCount: 2, responseCount: 0, childCount: 1, createdAt: NOW - 1000 }),
    ]),
    '/api/projects/x/sessions/s1/turns?origins=agent_dispatch%2Chook_injected%2Csystem%2Cunknown%2Cuser&limit=200&order=desc': () => page([
      turn({ promptId: P1, preview: 'Please rename the project card', toolCallCount: 1, responseCount: 1 }),
      turn({ promptId: P2, origin: 'system', preview: '<system-reminder>injected</system-reminder>', textChars: 40, toolCallCount: 0, responseCount: 0, createdAt: NOW - 2000 }),
      turn({ promptId: P3, preview: null, textChars: null, blobKey: KEY_TEXT, toolCallCount: 2, responseCount: 0, childCount: 1, createdAt: NOW - 1000 }),
    ]),
    [`/api/projects/x/sessions/s1/turns?origins=user,system,agent_dispatch,hook_injected,unknown&turn=${P1}`]: () => page([turn({ promptId: P1 })]),
    [`/api/projects/x/sessions/s1/turns?origins=user,system,agent_dispatch,hook_injected,unknown&turn=${P2}`]: () => page([turn({ promptId: P2, origin: 'system' })]),
    [`/api/projects/x/sessions/s1/turns/${P1}`]: () => Response.json({
      prompt: { promptId: P1, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: `Please rename the project card ${'x'.repeat(130)}\n\nAnd the rest of a long prompt.`, blobKey: null, createdAt: NOW - 3000 },
      responses: [{ responseId: 'r1', promptId: P1, text: 'done', blobKey: null, createdAt: NOW - 1000, orderedAt: NOW - 1000 }],
      attachments: [
        { attachmentId: 'a1', promptId: P1, blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 1234, description: 'a screenshot', createdAt: NOW, orderedAt: NOW },
        { attachmentId: 'turn-file', promptId: P1, blobKey: KEY_SVG, mediaType: 'image/svg+xml', byteSize: 99, description: 'a turn diagram', createdAt: NOW, orderedAt: NOW },
      ],
      plans: [], injection: null, children: [],
    }),
    [`/api/projects/x/sessions/s1/turns/${P3}`]: () => Response.json({
      prompt: { promptId: P3, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: null, blobKey: KEY_TEXT, createdAt: NOW - 1000 },
      responses: [], attachments: [], plans: [], injection: null,
      children: [{ prompt: { promptId: P2, origin: 'user', promptKind: null, parentPromptId: P3, threadLabel: 'reviewer', text: 'steer it left', blobKey: null, createdAt: NOW - 900 }, responses: [{ responseId: 'r2', promptId: P2, text: 'steered', blobKey: null, createdAt: NOW - 800, orderedAt: NOW - 800 }], toolCallCount: 0 }],
    }),
    [`/api/projects/x/sessions/s1/turns/${P1}/tool-calls?limit=200`]: () => page([
      { toolCallId: 't1', promptId: P1, toolName: 'Write', mycoTool: null, mycoOp: null, inputPreview: 'x'.repeat(20), inputBytes: 190_000, inputTruncated: true, inputBlobKey: null, outputPreview: 'wrote it', outputBlobKey: null, success: false, errorMessage: 'disk full', durationMs: 42, filesAffected: '["/repo/a.ts"]', createdAt: NOW - 2000, orderedAt: NOW - 2000 },
    ]),
    '/api/projects/x/sessions/s1/plans': () => page([]),
    '/api/projects/x/sessions/s1/context-injections': () => page([{ kind: 'cortex', createdAt: NOW - HOUR, orderedAt: NOW - HOUR }]),
    '/api/projects/x/sessions/s1/attachments': () => page([
      { attachmentId: 'a1', promptId: P1, blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 1234, description: 'a screenshot', createdAt: NOW, orderedAt: NOW },
      { attachmentId: 'a3', promptId: '00000000-0000-7000-8000-000000000009', blobKey: KEY_IMG, mediaType: 'image/png', byteSize: 10, description: 'on a steering prompt', createdAt: NOW, orderedAt: NOW },
      { attachmentId: 'a2', promptId: null, blobKey: KEY_SVG, mediaType: 'image/svg+xml', byteSize: 99, description: 'a diagram', createdAt: NOW, orderedAt: NOW },
    ]),
    '/api/projects/x/sessions/s1/transcript': () => Response.json(transcriptPayload()),
    [`/api/projects/x/processed/prompt/${P3}`]: () => new Response('{"a":1}', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    ...over,
  }, me);

  /** Every transcript the session holds, each carrying its own segments. */
  const transcriptPayload = () => {
    const segments = [
      { baseOffset: 0, length: 4_000_000, blobKey: KEY_SEG, createdAt: NOW - 3000 },
      { baseOffset: 4_000_000, length: 3_340_032, blobKey: KEY_SEG, createdAt: NOW },
    ];
    const primary = {
      transcriptId: 'tx1', sessionId: 's1', machineId: 'mac-1', agent: 'claude-code', originPath: '/repo/.claude/s1.jsonl',
      size: 7_340_032, segmentCount: 2, firstReceivedAt: NOW - 3000, lastReceivedAt: NOW,
      role: 'primary', parsedOffset: 7_340_032, parsedAt: NOW, fidelity: 'full', parseError: null, parseFailedAt: null, segments,
    };
    return { transcript: primary, transcripts: [primary], segments };
  };

  it('leads with the title and summary, keeps the facts and what came of it beside the conversation, and shows no raw id', async () => {
    server(routes());
    mount('/p/x/sessions/s1');
    const title = await screen.findByRole('heading', { level: 1 });
    expect(title.textContent).toBe('Flaky test port collision fixed');
    // The page names its project in the scope switcher beside its breadcrumbs.
    const scope = screen.getByRole('button', { name: 'Showing: Project X' });
    fireEvent.keyDown(scope, { key: 'Enter' });
    const scopes = await screen.findByRole('menu', { name: /^Showing: / });
    // "All projects" leads to the list across every project, and says it leaves this page.
    expect(scopes.querySelector('[data-scope-option="all"]')!.textContent).toBe('All projectsLeaves this page for the list across every project.');
    expect(scopes.querySelector('[data-scope-all-reason]')).toBeNull();
    fireEvent.keyDown(scopes, { key: 'Escape' });
    const page = document.querySelector('[data-session-page]')!;
    const summary = page.querySelector('[data-summary]')!;
    expect(summary.textContent).toBe('The test reserved a fixed port.\nIt now asks the kernel for one.');
    // The summary comes before the conversation, and the conversation sits in the reading column.
    const tabs = screen.getByRole('tablist', { name: 'What the session holds' });
    expect(summary.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Conversation2', 'Spores12', 'Plans0']));
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe('SessionsProject X');
    // The facts, in words; the id is only copied.
    const facts = screen.getByRole('complementary', { name: 'About this session' });
    const factText = facts.querySelector('[data-facts]')!.textContent!;
    for (const words of ['Project X', 'Claude Code', 'Ada’s studio Mac', 'Ada', 'main', '/repo', 'Released · v1.2.0', '2 prompts · 3 tool calls · 1 reply']) expect(factText).toContain(words);
    expect(within(facts).getByRole('button', { name: 'Copy session id' })).toBeTruthy();
    expect(factText).not.toContain('s1');
    // The raw data is folded away at the foot, and the conversation's last typed turn is open.
    const raw = screen.getByRole('region', { name: 'Raw data' });
    expect(within(raw).getByRole('button', { name: 'Raw data' }).getAttribute('aria-expanded')).toBe('false');
    expect(await within(await screen.findByTestId(`turn-${P3}`)).findByTestId('turn-body')).toBeTruthy();
    expect(rawIdsInPage()).toEqual([]);
  });

  it('copies the resume command the server words, verbatim, and offers none when the session can’t be resumed', async () => {
    const line = "cd '/Users/ada/it'\\''s repo' && claude --resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    const copied: string[] = [];
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    try {
      server(routes({ '/api/projects/x/sessions/s1': () => detail({ title: 'Flaky test port collision fixed' }, { resume: { command: 'claude --resume 0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', line } }) }));
      mount('/p/x/sessions/s1');
      const facts = await screen.findByRole('complementary', { name: 'About this session' });
      const copy = await within(facts).findByRole('button', { name: 'Copy resume command' });
      expect(copy.closest('[data-facts]')).not.toBeNull();
      fireEvent.click(copy);
      await waitFor(() => expect(copied).toEqual([line]));
      expect(facts.textContent).not.toContain('claude --resume');
      cleanup();
      server(routes({ '/api/projects/x/sessions/s1': () => detail({ title: 'Flaky test port collision fixed' }, { resume: null }) }));
      mount('/p/x/sessions/s1');
      await screen.findByRole('button', { name: 'Copy session id' });
      expect(screen.queryByRole('button', { name: 'Copy resume command' })).toBeNull();
    } finally {
      if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard'); else Object.defineProperty(navigator, 'clipboard', clipboard);
    }
  });

  it('says what came of the session: its spores, and each run with whether the Deployment holds a record of its reading', async () => {
    server(routes());
    mount('/p/x/sessions/s1');
    const outcome = await screen.findByText('What came of it').then((h) => h.closest('[data-outcome]') as HTMLElement);
    const spores = within(outcome).getByRole('list', { name: 'Spores from this session' });
    expect(within(spores).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'GotchaA reserved test port races the ephemeral fallback.',
      'FixSep 29',
    ]);
    expect(within(spores).getAllByRole('link')[0]!.getAttribute('href')).toBe('/p/x/spores/sp1');
    // Ten are listed at the most; the rest are one link away, on the Spores tab.
    expect(within(outcome).getByRole('link', { name: 'All 12 spores →' }).getAttribute('href')).toBe('/p/x/sessions/s1?tab=spores');

    const runs = within(within(outcome).getByRole('list', { name: 'Myco’s work on this session' })).getAllByRole('listitem');
    expect(runs.map((li) => li.getAttribute('data-outcome-run'))).toEqual(['read', 'unrecorded', 'read', 'unrecorded']);
    expect(runs[0]!.textContent).toContain('Myco learned 2 spores from it');
    expect(runs[0]!.textContent).toContain('Read it at 15:11');
    expect(runs[1]!.textContent).toContain('Myco learned 1 spore from it');
    expect(runs[1]!.textContent).toContain('Failed');
    expect(runs[2]!.textContent).toContain('Myco titled it');
    // A title run dispatched on this session before reads were recorded: no record, never "read nothing".
    expect(runs[3]!.textContent).toContain('Myco was asked to title it');
    for (const run of [runs[1]!, runs[3]!]) {
      expect(run.textContent).toContain('No record of what it read');
      expect(run.textContent).not.toMatch(/read nothing/i);
    }
    expect(within(runs[3]!).getByRole('link').getAttribute('href')).toBe('/p/x/work/runs/run_0ld7171e00');
    expect(rawIdsInPage()).toEqual([]);
  });

  it('says nothing came of a session yet, and why, whether it is open or ended', async () => {
    server(base({ '/api/projects/x/sessions/s1': () => detail({ label: 'Try the login flow' }), '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([]) }));
    mount('/p/x/sessions/s1');
    expect((await screen.findByText(/^Nothing yet/)).textContent).toBe('Nothing yet. Myco learns from a session once it ends.');
    // Open and untitled: headed by what the person typed, marked Untitled, and the summary waits for the end.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('UntitledTry the login flow');
    expect(screen.getByText('Myco writes a summary once the session ends.')).toBeTruthy();
    cleanup();
    server(base({ '/api/projects/x/sessions/s1': () => detail({ endedAt: NOW - HOUR }, { untitled: 'stopped' }), '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([]) }));
    mount('/p/x/sessions/s1');
    expect((await screen.findByText(/^Nothing yet/)).textContent).toBe('Nothing yet. Myco hasn’t learned anything from this session.');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('UntitledUntitled session');
    expect(screen.getByText(/^Untitled: Myco stopped trying/)).toBeTruthy();
  });

  it('keeps an admin’s delete, end and new title in the ⋯ menu, each behind a confirmation, and shows a member none of them', async () => {
    let titled = false;
    let ended = false;
    let deleteAttempts = 0;
    const { requested } = server(routes({
      '/api/projects/x/sessions/s1': () => detail(ended ? { endedAt: NOW, endedBy: 'mem_q3Vb8xRk2LmT7wYz', endedByLabel: 'Ada' } : titled ? { title: 'Renamed the card', summary: 'Renamed it.' } : { label: 'Rename the card' }),
      '/api/projects/x/sessions/s1/title': () => { titled = true; return Response.json({ outcome: 'dispatched', runId: 'run_t1aaaaaa' }); },
      '/api/projects/x/runs/run_t1aaaaaa': () => Response.json({ run: { id: 'run_t1aaaaaa', status: 'running' }, phases: [], reports: [], projectId: 'x' }),
      '/api/projects/x/sessions/s1/end': () => { ended = true; return Response.json({ outcome: 'ended', endedAt: NOW }); },
      '/api/projects/x/sessions/s1/tombstone': () => {
        deleteAttempts += 1;
        return deleteAttempts === 1 ? new Response(null, { status: 503 }) : Response.json({ applied: true, removed: 8, blobsFreed: 2, blobsLeft: 0 });
      },
      '/api/sessions': () => page([]),
    }));
    const client = mount('/p/x/sessions/s1');
    const openMenu = async () => {
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Session actions' }), { key: 'Enter' });
      return screen.findByRole('menu');
    };

    // A new title: named, cancelled with nothing sent, then confirmed; the page follows the run until the title lands.
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Write a new title' }));
    let dialog = await screen.findByRole('dialog', { name: 'Write a new title?' });
    expect(dialog.textContent).toContain('Rename the card');
    expect(dialog.textContent).toContain('spends tokens');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requested.some((p) => p.endsWith('/title'))).toBe(false);
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Write a new title' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Write a new title?' })).getByRole('button', { name: 'Write a new title' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findByText('The new title is in')).getAttribute('role')).toBe('status');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Renamed the card'));

    // End: offered while open, named, confirmed; once ended the menu no longer offers it, and every list that shows the session is read again.
    const lists = [['sessions', 'all', listPath({ projectId: null })], ['sessions', 'live', 'all', 'x'], ['today', 'sessions', 'all', TODAY]] as const;
    for (const key of lists) client.setQueryData(key, { rows: [], cursor: null });
    expect(lists.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([false, false, false]);
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'End session' }));
    dialog = await screen.findByRole('dialog', { name: 'End this session?' });
    expect(dialog.textContent).toContain('Capture isn’t stopped');
    fireEvent.click(within(dialog).getByRole('button', { name: 'End session' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(lists.map((key) => client.getQueryState(key)?.isInvalidated)).toEqual([true, true, true]));
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'About this session' }).textContent).toContain('by Ada'));
    expect(within(await openMenu()).queryByRole('menuitem', { name: 'End session' })).toBeNull();

    // Delete: names what goes and what stays, keeps the dialog open on a failure, and leaves for the list once done.
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Delete session' }));
    dialog = await screen.findByRole('dialog', { name: 'Delete this session?' });
    expect(dialog.textContent).toContain('The spores learned from it, and other sessions');
    expect(dialog.querySelector('[data-delete-impact]')!.textContent).toBe('2 prompts · 3 tool calls · 0 plans · 2 attachments');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Try again');
    expect(location()).toBe('/p/x/sessions/s1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(location()).toBe('/p/x/sessions'));
    expect(deleteAttempts).toBe(2);
    expect(rawIdsInPage()).toEqual([]);
    cleanup();

    server(routes({}, MEMBER));
    mount('/p/x/sessions/s1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('button', { name: 'Session actions' })).toBeNull();
  });

  it('says so when a new title could not be started, keeping the dialog open', async () => {
    server(routes({ '/api/projects/x/sessions/s1/title': () => new Response(null, { status: 503 }) }));
    mount('/p/x/sessions/s1');
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Session actions' }), { key: 'Enter' });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Write a new title' }));
    const dialog = await screen.findByRole('dialog', { name: 'Write a new title?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Write a new title' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Myco couldn’t start writing a title. Try again.');
  });

  it('shows each prompt a person typed with what followed it inline, reading a turn’s body only once it nears the screen', async () => {
    // A stand-in for the browser's observer: nothing is on screen until a test says so.
    const watched = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>();
    const original = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(el: Element) { watched.set(el, this.callback); }
      disconnect() { for (const [el, cb] of watched) if (cb === this.callback) watched.delete(el); }
      unobserve() {}
    };
    const reach = (el: Element) => act(() => { watched.get(el)?.([{ isIntersecting: true }]); });
    try {
      const { requested } = server(routes());
      mount('/p/x/sessions/s1');
      const first = await screen.findByTestId(`turn-${P1}`);
      const last = screen.getByTestId(`turn-${P3}`);
      // Before its body is read a turn shows the prompt's opening from the list, and nothing is folded.
      expect(first.textContent).toContain(`Please rename the project card ${'x'.repeat(PROMPT_PREVIEW_CHARS - 'Please rename the project card '.length)}…`);
      expect(within(first).queryByRole('button', { expanded: false })).toBeNull();
      expect(screen.getAllByTestId(/^turn-0000/).map((el) => el.getAttribute('data-testid'))).toEqual([`turn-${P1}`, `turn-${P3}`]);
      expect(requested.filter((p) => p.includes('/turns/'))).toEqual([]);

      await reach(last);
      // A prompt kept as stored text is read only when asked for.
      fireEvent.click(await within(last).findByRole('button', { name: 'Show the whole prompt' }));
      expect(await within(last).findByText('{"a":1}')).toBeTruthy();
      expect(requested).toContain(`/api/projects/x/processed/prompt/${P3}`);
      expect(requested).not.toContain(BLOB(KEY_TEXT));
      expect(within(last).getByTestId('turn-child').textContent).toContain('steer it left');
      expect(within(last).getByTestId('turn-child').textContent).toContain('reviewer');
      expect(requested.filter((p) => p.includes('/turns/'))).toEqual([`/api/projects/x/sessions/s1/turns/${P3}`]);

      await reach(first);
      // The whole prompt, its image and its reply sit inline.
      await within(first).findByTestId('turn-response');
      expect(within(first).getByTestId('turn-response').textContent).toContain('done');
      expect(within(first).getByRole('img', { name: 'a screenshot' }).getAttribute('src')).toBe('/api/projects/x/processed/attachment/a1');
      expect(within(first).getByRole('link', { name: 'Download a turn diagram' }).getAttribute('href')).toBe('/api/projects/x/processed/attachment/turn-file');
      fireEvent.click(within(first).getByRole('button', { name: 'Open a screenshot' }));
      const lightbox = await screen.findByRole('dialog', { name: 'Image' });
      expect(within(lightbox).getByRole('img', { name: 'a screenshot' }).getAttribute('src')).toBe('/api/projects/x/processed/attachment/a1');
      fireEvent.click(within(lightbox).getByRole('button', { name: 'Close' }));
      expect(first.textContent).toContain('And the rest of a long prompt.');
    } finally {
      (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    }
  });

  it('reads spilled replies and steering prompts by typed identities, and links bundled and legacy tool bodies', async () => {
    const { requested } = server(routes({
      [`/api/projects/x/sessions/s1/turns/${P1}`]: () => Response.json({
        prompt: { promptId: P1, text: 'Please rename the project card', blobKey: null, origin: 'user', createdAt: NOW },
        responses: [{ responseId: 'reply-spill', text: null, blobKey: KEY_TEXT, createdAt: NOW }],
        attachments: [], plans: [], injection: null,
        children: [{ prompt: { promptId: P2, text: null, blobKey: KEY_TEXT, origin: 'user', createdAt: NOW }, responses: [], toolCallCount: 0 }],
      }),
      '/api/projects/x/processed/response/reply-spill': () => new Response('A complete processed reply'),
      [`/api/projects/x/processed/prompt/${P2}`]: () => new Response('A complete steering prompt'),
      [`/api/projects/x/sessions/s1/turns/${P1}/tool-calls?limit=200`]: () => page([
        { toolCallId: 't-spill', promptId: P1, toolName: 'Read', mycoTool: null, mycoOp: null, inputPreview: 'é'.repeat(1023), inputBytes: 2054, inputTruncated: true, inputBlobKey: null, outputPreview: 'preview', outputBlobKey: KEY_TEXT, success: true, errorMessage: null, durationMs: 1, filesAffected: null, createdAt: NOW, orderedAt: NOW },
        { toolCallId: 't-legacy', promptId: P1, toolName: 'Read', mycoTool: null, mycoOp: null, inputPreview: 'legacy', inputBytes: 2054, inputTruncated: true, inputBlobKey: KEY_TEXT, outputPreview: null, outputBlobKey: null, success: true, errorMessage: null, durationMs: 1, filesAffected: null, createdAt: NOW+1, orderedAt: NOW+1 },
      ]),
    }, MEMBER));
    mount('/p/x/sessions/s1');
    expect(await screen.findByText('A complete processed reply')).toBeTruthy();
    expect(await screen.findByText('A complete steering prompt')).toBeTruthy();
    const first = screen.getByTestId(`turn-${P1}`);
    fireEvent.click(within(first).getByTestId('tool-calls-toggle'));
    const row = await screen.findByTestId('tool-call-t-spill');
    fireEvent.click(within(row).getByRole('button'));
    expect(within(row).getByText(`${'é'.repeat(1023)}…`)).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Full input' }).getAttribute('href')).toBe('/api/projects/x/processed/tool-input/t-spill');
    expect(within(row).getByRole('link', { name: 'Full output' }).getAttribute('href')).toBe('/api/projects/x/processed/tool-output/t-spill');
    const legacy = await screen.findByTestId('tool-call-t-legacy');
    fireEvent.click(within(legacy).getByRole('button'));
    expect(within(legacy).getByRole('link', { name: 'Full input' }).getAttribute('href')).toBe('/api/projects/x/processed/tool-input/t-legacy');
    expect(requested).not.toContain(BLOB(KEY_TEXT));
  });

  it('gate 1643.1: continues every turn collection and steering replies, retaining content when a page fails', async () => {
    const prompt = (id: string, text: string) => ({ promptId: id, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text, blobKey: null, createdAt: NOW });
    const replies = (offset: number, length: number, parent = P1) => Array.from({ length }, (_, i) => ({ responseId: `${parent}-reply-${offset + i}`, promptId: parent, text: `Reply ${parent} ${offset + i}`, blobKey: null, createdAt: NOW, orderedAt: NOW }));
    const attachments = (offset: number, length: number) => Array.from({ length }, (_, i) => ({ attachmentId: `file-${offset + i}`, promptId: P1, blobKey: KEY_TEXT, mediaType: 'application/pdf', byteSize: 1, description: `File ${offset + i}`, createdAt: NOW, orderedAt: NOW }));
    const plans = (offset: number, length: number) => Array.from({ length }, (_, i) => ({ planKey: `plan-${offset + i}`, promptId: P1, title: `Plan ${offset + i}`, status: 'draft', content: null, blobKey: null, originPath: null, progress: '', updatedBy: null, createdAt: NOW, updatedAt: NOW, orderedAt: NOW }));
    const children = (offset: number, length: number) => Array.from({ length }, (_, i) => ({ prompt: prompt(`child-${offset + i}`, `Steering ${offset + i}`), toolCallCount: 0, responses: offset + i === 0 ? replies(0, 50, 'child-0') : [], responsesCursor: offset + i === 0 ? 'child-next' : null }));
    let failReplies = true;
    const turnPath = `/api/projects/x/sessions/s1/turns/${P1}`;
    const { requested } = server(routes({
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ responseCount: 51, childCount: 51, attachmentCount: 51, planCount: 51, toolCallCount: 0 })]),
      [turnPath]: () => Response.json({ prompt: prompt(P1, 'Turn with many parts'), responses: replies(0, 50), attachments: attachments(0, 50), plans: plans(0, 50), children: children(0, 50), injection: null, cursors: { responses: 'next', attachments: 'next', plans: 'next', children: 'next' } }),
      [`${turnPath}?collection=responses&cursor=next`]: () => failReplies ? new Response(null, { status: 503 }) : page(replies(50, 1)),
      [`${turnPath}?collection=attachments&cursor=next`]: () => page(attachments(50, 1)),
      [`${turnPath}?collection=plans&cursor=next`]: () => page(plans(50, 1)),
      [`${turnPath}?collection=children&cursor=next`]: () => page(children(50, 1)),
      '/api/projects/x/sessions/s1/turns/child-0?collection=responses&cursor=child-next': () => page(replies(50, 1, 'child-0')),
    }));
    mount('/p/x/sessions/s1', new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    const body = await screen.findByText('Turn with many parts');
    const card = body.closest('li')!;
    for (const label of ['attachments', 'plans', 'steering prompts']) fireEvent.click(within(card).getByRole('button', { name: `Show more ${label}` }));
    expect(await screen.findByText('Download File 50')).toBeTruthy();
    expect(await screen.findByText('Plan 50')).toBeTruthy();
    expect(await screen.findByText('Steering 50')).toBeTruthy();
    const firstChild = screen.getAllByTestId('turn-child')[0]!;
    fireEvent.click(within(firstChild).getByRole('button', { name: 'Show more replies' }));
    expect(await screen.findByText('Reply child-0 50')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Show more replies' }));
    expect(await within(card).findByRole('alert')).toBeTruthy();
    expect(within(card).getByText(`Reply ${P1} 0`)).toBeTruthy();
    failReplies = false;
    fireEvent.click(within(card).getByRole('button', { name: 'Retry reading replies' }));
    expect(await screen.findByText(`Reply ${P1} 50`)).toBeTruthy();
    expect(requested.filter((path) => path.includes('collection=children'))).toHaveLength(1);
  });

  it('gate 1643.1: reopening a paged turn refreshes retained replies and discovers late continuations', async () => {
    let total = 51;
    let failRefresh = false;
    const replies = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => ({ responseId: `reply-${start + i}`, promptId: P1, text: `Retained reply ${start + i}`, blobKey: null, createdAt: NOW, orderedAt: NOW }));
    const turnPath = `/api/projects/x/sessions/s1/turns/${P1}`;
    const { requested } = server(routes({
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ responseCount: total, toolCallCount: 0 })]),
      [turnPath]: () => Response.json({
        prompt: { promptId: P1, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: 'Turn receiving late replies', blobKey: null, createdAt: NOW },
        responses: replies(1, 51), attachments: [], plans: [], children: [], injection: null,
        cursors: { responses: 'next', attachments: null, plans: null, children: null },
      }),
      [`${turnPath}?collection=responses`]: () => failRefresh ? new Response(null, { status: 503 }) : page(replies(1, 51), 'next'),
      [`${turnPath}?collection=responses&cursor=next`]: () => page(replies(51, Math.min(total + 1, 101)), total > 100 ? 'last' : null),
      [`${turnPath}?collection=responses&cursor=last`]: () => page(replies(101, total + 1)),
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount('/p/x/sessions/s1', client);
    await screen.findByText('Turn receiving late replies');
    expect(requested.filter((path) => path.includes('collection='))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
    expect(await screen.findByText('Retained reply 51')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more replies' })).toBeNull();
    cleanup();

    total = 52;
    mount('/p/x/sessions/s1', client);
    expect(await screen.findByText('Retained reply 52')).toBeTruthy();
    expect(requested.filter((path) => path.includes('collection=') && !path.includes('collection=responses'))).toHaveLength(0);
    cleanup();

    total = 101;
    mount('/p/x/sessions/s1', client);
    expect(await screen.findByText('Retained reply 100')).toBeTruthy();
    expect(screen.queryByText('Retained reply 101')).toBeNull();
    expect(requested.filter((path) => path.endsWith('cursor=last'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
    expect(await screen.findByText('Retained reply 101')).toBeTruthy();
    cleanup();

    failRefresh = true;
    mount('/p/x/sessions/s1', client);
    expect(await screen.findByText(/More replies could not be read/)).toBeTruthy();
    expect(screen.getByText('Retained reply 101')).toBeTruthy();
    failRefresh = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry reading replies' }));
    await waitFor(() => expect(screen.queryByText(/More replies could not be read/)).toBeNull());
    expect(screen.getByText('Retained reply 101')).toBeTruthy();
  });

  for (const refresh of ['cached', 'failed', 'fresh'] as const) {
    it(`gate 1643.1: inserted first-page replies appear once with ${refresh} parent detail and retained continuations`, async () => {
      let changed = false;
      const reply = (id: number) => ({ responseId: `insert-reply-${id}`, promptId: P1, text: `Inserted-page reply ${id}`, blobKey: null, createdAt: NOW, orderedAt: NOW });
      const original = Array.from({ length: 61 }, (_, i) => reply(i + 1));
      const inserted = reply(25.5);
      const current = () => changed ? [...original.slice(0, 25), inserted, ...original.slice(25)] : original;
      const turnPath = `/api/projects/x/sessions/s1/turns/${P1}`;
      const body = () => Response.json({
        prompt: { promptId: P1, origin: 'user', text: 'A turn with shifting pages', blobKey: null, createdAt: NOW },
        responses: current().slice(0, 50), attachments: [], plans: [], children: [], injection: null,
        cursors: { responses: changed ? 'new' : 'old', attachments: null, plans: null, children: null },
      });
      const { requested } = server(routes({
        '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ responseCount: 62, toolCallCount: 0 })]),
        [turnPath]: () => changed && refresh === 'failed' ? new Response(null, { status: 503 }) : body(),
        [`${turnPath}?collection=responses`]: () => page(current().slice(0, 50), changed ? 'new' : 'old'),
        [`${turnPath}?collection=responses&cursor=old`]: () => page(original.slice(50)),
        [`${turnPath}?collection=responses&cursor=new`]: () => page([current()[49]!, ...current().slice(50)]),
      }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
      mount('/p/x/sessions/s1', client);
      await screen.findByText('A turn with shifting pages');
      expect(requested.some((path) => path.includes('collection='))).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Show more replies' }));
      expect(await screen.findByText('Inserted-page reply 61')).toBeTruthy();
      changed = true;
      if (refresh === 'fresh') {
        await act(async () => { await client.invalidateQueries({ queryKey: ['turn', 'x', 's1', P1], exact: true }); });
      } else {
        cleanup();
        if (refresh === 'failed') client.setQueryDefaults(['turn', 'x', 's1', P1], { staleTime: 0 });
        mount('/p/x/sessions/s1', client);
      }
      expect(await screen.findByText('Inserted-page reply 25.5')).toBeTruthy();
      await waitFor(() => expect(screen.getAllByTestId('turn-response')).toHaveLength(62));
      for (const row of [...original, inserted]) expect(screen.getAllByText(row.text)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Show more replies' })).toBeNull();
      if (refresh === 'failed') expect(await screen.findByText(/Showing the last successful this turn read/)).toBeTruthy();
      if (refresh === 'cached') expect(requested.filter((path) => path === turnPath)).toHaveLength(1);
    });
  }

  it('gate 1643.1: overlapping plan identities retain the latest status and every final plan', async () => {
    const plan = (id: number, status = 'draft') => ({ planKey: `merge-plan-${id}`, promptId: P1, title: `Merge plan ${id}`, status, content: null, blobKey: null, originPath: null, progress: '', updatedBy: null, createdAt: NOW, updatedAt: NOW, orderedAt: NOW });
    const turnPath = `/api/projects/x/sessions/s1/turns/${P1}`;
    server(routes({
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ planCount: 51, toolCallCount: 0 })]),
      [turnPath]: () => Response.json({ prompt: { promptId: P1, text: 'Plans sharing page boundaries', blobKey: null, origin: 'user', createdAt: NOW }, responses: [], attachments: [], children: [], injection: null, plans: Array.from({ length: 50 }, (_, i) => plan(i + 1)), cursors: { plans: 'next' } }),
      [`${turnPath}?collection=plans&cursor=next`]: () => page([plan(1, 'completed'), plan(51)]),
    }));
    mount('/p/x/sessions/s1');
    await screen.findByText('Plans sharing page boundaries');
    fireEvent.click(screen.getByRole('button', { name: 'Show more plans' }));
    expect(await screen.findByText('Merge plan 51')).toBeTruthy();
    expect(screen.getAllByText('Merge plan 1')).toHaveLength(1);
    expect(screen.getByText('Merge plan 1').closest('[data-plan-line]')?.getAttribute('data-plan-line')).toBe('completed');
    expect(screen.getByTestId('turn-plans').children).toHaveLength(51);
  });

  it('gate 1643.3: an initial turn-body failure offers a manual retry that reads the body', async () => {
    let failed = true;
    const turnPath = `/api/projects/x/sessions/s1/turns/${P1}`;
    const { requested } = server(routes({
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ toolCallCount: 0 })]),
      [turnPath]: () => failed ? new Response(null, { status: 503 }) : Response.json({ prompt: { promptId: P1, text: 'Recovered turn', blobKey: null, origin: 'user', createdAt: NOW }, responses: [{ responseId: 'recovered', text: 'Recovered reply', blobKey: null, createdAt: NOW }], attachments: [], plans: [], children: [], injection: null }),
    }));
    mount('/p/x/sessions/s1');
    const card = await screen.findByTestId(`turn-${P1}`);
    expect(await within(card).findByText(/Couldn’t read this turn/)).toBeTruthy();
    failed = false;
    fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(await within(card).findByText('Recovered reply')).toBeTruthy();
    expect(within(card).queryByRole('alert')).toBeNull();
    expect(requested.filter((path) => path === turnPath)).toHaveLength(2);
  });

  it('gate 1643.2: opens 5,001 turns at the newest page, then reads earlier pages only on request', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => turn({ promptId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, preview: `prompt ${i}`, createdAt: NOW - (5001 - i) * MINUTE, toolCallCount: 0, responseCount: 0 }));
    const path = '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc';
    const { requested } = server(routes({
      [path]: () => page(many.slice(-200).reverse(), 'older'),
      [`${path}&cursor=older`]: () => page(many.slice(-400, -200).reverse(), 'more-older'),
    }));
    mount('/p/x/sessions/s1');
    await waitFor(() => expect(screen.getAllByTestId(/^turn-0000/)).toHaveLength(200));
    expect(requested.filter((p) => p.startsWith(path))).toHaveLength(1);
    expect(screen.getAllByTestId(/^turn-0000/).at(-1)!.textContent).toContain('prompt 5000');
    expect(screen.getAllByTestId(/^turn-0000/)[0]!.textContent).toContain('prompt 4801');
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: /Conversation/ }).textContent).toBe('Conversation');
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier turns' }));
    await waitFor(() => expect(screen.getAllByTestId(/^turn-0000/)).toHaveLength(400));
    expect(requested.filter((p) => p.startsWith(path))).toHaveLength(2);
    expect(screen.getAllByTestId(/^turn-0000/)[0]!.textContent).toContain('prompt 4601');
    expect(screen.getByRole('button', { name: 'Show earlier turns' })).toBeTruthy();
  });

  it('gate 1643.2: reads named turns on either side of the first page through bounded lookups', async () => {
    const path = '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc';
    for (const position of [0, 5000]) {
      const id = `00000000-0000-7000-8000-${String(position).padStart(12, '0')}`;
      const lookup = `/api/projects/x/sessions/s1/turns?origins=user,system,agent_dispatch,hook_injected,unknown&turn=${id}`;
      const { requested } = server(routes({
        [path]: () => page([turn({ promptId: P3, preview: 'Latest turn' })], 'older'),
        [lookup]: () => page([turn({ promptId: id, preview: `Linked turn ${position}`, textChars: `Linked turn ${position}`.length, createdAt: position })]),
      }));
      mount(`/p/x/sessions/s1?turn=${id}`);
      expect(await screen.findByText(`Linked turn ${position}`)).toBeTruthy();
      expect(requested.filter((p) => p.startsWith(path))).toHaveLength(1);
      expect(requested.filter((p) => p === lookup)).toHaveLength(1);
      expect(screen.getByText(/More turns may sit between them/)).toBeTruthy();
      cleanup();
    }
  });

  it('reads a turn’s tool calls only when they open, then shows how each went', async () => {
    const { requested } = server(routes());
    mount('/p/x/sessions/s1');
    const first = await screen.findByTestId(`turn-${P1}`);
    const toggle = await within(first).findByTestId('tool-calls-toggle');
    expect(requested.some((p) => p.includes('/tool-calls'))).toBe(false);
    fireEvent.click(toggle);
    const row = await within(first).findByTestId('tool-call-t1');
    expect(row.textContent).toContain('Write');
    expect(row.textContent).toContain('/repo/a.ts');
    expect(row.textContent).toContain('42ms');
    expect(within(row).queryByText('disk full')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    expect(within(row).getByText('disk full')).toBeTruthy();
    expect(within(row).getByText(/Input · 186 KB/)).toBeTruthy();
  });

  it('shows every prompt on request, and opens and scrolls to a turn a link names even when only the wider list holds it', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute('data-testid') ?? ''); };
    try {
      const { requested } = server(routes());
      mount('/p/x/sessions/s1');
      await screen.findByTestId(`turn-${P1}`);
      fireEvent.click(screen.getByRole('switch', { name: 'Show prompts from the system and sub-agents' }));
      const injected = await screen.findByTestId(`turn-${P2}`);
      expect(injected.getAttribute('data-origin')).toBe('system');
      expect(injected.textContent).toContain('System');
      cleanup();

      mount(`/p/x/sessions/s1?turn=${P1}`);
      await screen.findByTestId(`turn-${P1}`);
      await waitFor(() => expect(scrolled).toContain(`turn-${P1}`));
      cleanup();

      mount(`/p/x/sessions/s1?turn=${P2}`);
      await waitFor(() => expect(requested).toContain('/api/projects/x/sessions/s1/turns?origins=agent_dispatch%2Chook_injected%2Csystem%2Cunknown%2Cuser&limit=200&order=desc'));
      await waitFor(() => expect(screen.getByRole('switch', { name: 'Show prompts from the system and sub-agents' }).getAttribute('aria-checked')).toBe('true'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('shows what Myco added to a prompt as one folded line, opening on the spores it served', async () => {
    server(routes({
      '/api/projects/x/sessions/s1/turns?origins=user&limit=200&order=desc': () => page([turn({ promptId: P1, preview: 'Please rename the project card' })]),
      [`/api/projects/x/sessions/s1/turns/${P1}`]: () => Response.json({
        prompt: { promptId: P1, origin: 'user', promptKind: null, parentPromptId: null, threadLabel: null, text: 'Please rename the project card', blobKey: null, createdAt: NOW - 3000 },
        responses: [], attachments: [], plans: [], children: [],
        injection: { sporeIds: ['sp1', 'sp2', 'sp_gone'], createdAt: NOW - 3100, spores: [
          { id: 'sp1', observationType: 'decision', preview: 'the selector reads recency' },
          { id: 'sp2', observationType: 'bug_fix', preview: 'the hook answers before the event lands' },
        ] },
      }),
    }));
    mount('/p/x/sessions/s1');
    const row = await within(await screen.findByTestId(`turn-${P1}`)).findByTestId('turn-injection');
    expect(row.textContent).toContain('Myco added 2 spores to this prompt');
    expect(within(row).queryByText('the selector reads recency')).toBeNull();
    fireEvent.click(within(row).getByRole('button'));
    expect(await within(row).findByText('the selector reads recency')).toBeTruthy();
    expect(within(row).getByText('Fix')).toBeTruthy();
    expect(within(row).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/p/x/spores/sp1', '/p/x/spores/sp2']);
    expect(within(row).getByText('1 spore no longer kept')).toBeTruthy();
  });

  it('lists the session’s spores on their tab, whatever their status, and says when only the newest are listed', async () => {
    const spore = (over: Record<string, unknown>) => ({ id: 'sp1', agentId: 'agent_1', sessionId: 's1', promptId: null, observationType: 'gotcha', status: 'active', content: 'The cache lies after a rebase.', agentLine: null, context: null, importance: 8, filePath: null, tags: null, contentHash: null, properties: null, createdAt: NOW - MINUTE, updatedAt: null, embedded: 0, ...over });
    server(routes({ '/api/projects/x/spores?limit=100&session=s1': () => Response.json({ spores: [spore({}), spore({ id: 'sp2', observationType: 'trade_off', status: 'superseded', agentLine: 'We page by offset.' })], total: 140, maxPage: 200 }) }));
    mount('/p/x/sessions/s1?tab=spores');
    const items = await within(await screen.findByRole('list', { name: 'Spores' })).findAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Gotcha');
    expect(items[0]!.textContent).toContain('The cache lies after a rebase.');
    expect(items[1]!.textContent).toContain('Superseded');
    expect(items[1]!.textContent).toContain('We page by offset.');
    expect(within(items[0]!).getByRole('link').getAttribute('href')).toBe('/p/x/spores/sp1');
    expect(screen.getByText('The 2 newest of 140 spores.')).toBeTruthy();
    cleanup();
    server(routes({ '/api/projects/x/spores?limit=100&session=s1': () => new Response(null, { status: 500 }) }));
    mount('/p/x/sessions/s1?tab=spores');
    expect(await screen.findByText('The server had a problem')).toBeTruthy();
    expect(screen.queryByText(/No spores were saved/)).toBeNull();
  });

  it('lists the session’s plans on their tab, each leading to its own page', async () => {
    server(routes({ '/api/projects/x/sessions/s1/plans': () => page([
      { planKey: 'plan-1', promptId: P1, title: 'Ship the thing', status: 'in_progress', content: '# Plan\n- [x] one\n- [ ] two', blobKey: null, originPath: '.claude/plans/ship.md', progress: '1/2', updatedBy: null, createdAt: NOW - 5000, updatedAt: NOW - HOUR, orderedAt: NOW - 1000 },
    ]) }));
    mount('/p/x/sessions/s1?tab=plans');
    const line = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-plan-line="in_progress"]');
      if (found === null) throw new Error('the plan is not listed yet');
      return found;
    });
    expect(line.textContent).toContain('In progress');
    expect(line.textContent).toContain('1 of 2 items done');
    expect(line.textContent).toContain('updated 1 h ago');
    expect(within(line).getByRole('link', { name: 'Ship the thing' }).getAttribute('href')).toBe('/p/x/plans/plan-1');
  });

  it('folds the transcript, context and attachments into Raw data, links the transcript by piece, and never fetches its bytes', async () => {
    const { requested } = server(routes());
    mount('/p/x/sessions/s1');
    const raw = await screen.findByRole('region', { name: 'Raw data' });
    expect(requested.some((p) => p.endsWith('/transcript'))).toBe(false);
    fireEvent.click(within(raw).getByRole('button', { name: 'Raw data' }));
    const transcript = await within(raw).findByRole('region', { name: 'Transcript files' });
    expect(await within(transcript).findByText('The session’s transcript')).toBeTruthy();
    expect(transcript.textContent).toContain('7.0 MB · 2 pieces');
    expect(within(transcript).getAllByRole('link', { name: /^bytes / }).map((a) => a.getAttribute('href'))).toEqual([BLOB(KEY_SEG), BLOB(KEY_SEG)]);
    expect(requested).not.toContain(BLOB(KEY_SEG));
    expect(await within(raw).findByText('At the session’s start')).toBeTruthy();
    // Attachments sit under the prompt that carried them; those on prompts the conversation does not list share one group, and untied ones sit last.
    const attachments = within(raw).getByRole('region', { name: 'Attachments' });
    await within(attachments).findByRole('img', { name: 'a screenshot' });
    const groups = within(attachments).getAllByRole('region');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Please rename the project card', 'Other prompts in this session', 'Not tied to a prompt']);
    expect(within(groups[0]!).getByRole('link', { name: 'Open the prompt' }).getAttribute('href')).toBe(`/p/x/sessions/s1?turn=${P1}`);
    expect(within(groups[0]!).getByRole('img', { name: 'a screenshot' }).getAttribute('src')).toBe('/api/projects/x/processed/attachment/a1');
    expect(within(groups[2]!).getByText('Download a diagram').getAttribute('href')).toBe('/api/projects/x/processed/attachment/a2');
  });

  it('sends a link to an old tab to the raw data, open at that part', async () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.getAttribute('data-raw') ?? ''); };
    try {
      server(routes());
      mount('/p/x/sessions/s1?tab=transcript');
      await waitFor(() => expect(location()).toBe('/p/x/sessions/s1?raw=transcript'));
      const raw = await screen.findByRole('region', { name: 'Raw data' });
      expect(within(raw).getByRole('button', { name: 'Raw data' }).getAttribute('aria-expanded')).toBe('true');
      await waitFor(() => expect(scrolled).toContain('transcript'));
      cleanup();
      mount('/p/x/sessions/s1?tab=attachments&turn=t');
      await waitFor(() => expect(location()).toBe('/p/x/sessions/s1?turn=t&raw=attachments'));
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('words a transcript’s state by what the reader can do with it', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fidelity: 'no_tool_results' }, 'Read; this format may leave out some tool results'],
      [{ fidelity: 'no_tool_results', parseError: 'parse', parseFailedAt: NOW }, 'Could not be read in full'],
      [{ fidelity: 'no_tool_results', parsedOffset: 1_000_000 }, 'Still being read'],
    ];
    for (const [over, words] of cases) {
      const payload = transcriptPayload();
      const record = { ...payload.transcript, ...over };
      server(routes({ '/api/projects/x/sessions/s1/transcript': () => Response.json({ ...payload, transcript: record, transcripts: [record, { ...record, transcriptId: 'tx2', role: 'subagent', segments: [] }] }) }));
      mount('/p/x/sessions/s1?raw=transcript');
      expect((await screen.findAllByText(words)).length).toBe(2);
      expect(screen.getByText('A sub-agent’s transcript')).toBeTruthy();
      cleanup();
    }
    // An answer that carries no list reads as nothing captured, never a broken page.
    server(routes({ '/api/projects/x/sessions/s1/transcript': () => Response.json({ transcript: { transcriptId: 'tx1', sessionId: 's1', size: 1, segmentCount: 0 }, segments: [] }) }));
    mount('/p/x/sessions/s1?raw=transcript');
    expect(await screen.findByText('No transcript captured.')).toBeTruthy();
  });

  it('explains raw transcript privacy and does not request raw bytes when permission is absent', async () => {
    const viewer = dashboardMe(ADMIN);
    const denied = { ...viewer, permissions: { ...viewer.permissions, raw: { scope: 'none', reason: 'Raw uploads are private to their uploader.' } } };
    const { requested } = server(routes({}, denied));
    mount('/p/x/sessions/s1?raw=transcript');
    expect(await screen.findByText('Raw uploads are private to their uploader.')).toBeTruthy();
    expect(requested.some((path) => path.endsWith('/transcript'))).toBe(false);

    cleanup();
    server(routes({ '/api/projects/x/sessions/s1/transcript': () => Response.json({ error: 'forbidden' }, { status: 403 }) }));
    mount('/p/x/sessions/s1?raw=transcript');
    expect(await screen.findByText('Raw transcripts are private to the member whose machine uploaded them.')).toBeTruthy();
  });

  it('answers a session the server does not hold with not found, never forbidden', async () => {
    server(base());
    mount('/p/x/sessions/gone');
    expect(await screen.findByText('Not found')).toBeTruthy();
    expect(screen.queryByText(/forbidden/i)).toBeNull();
  });

  it('cuts a folded prompt at the preview length and names stored text', () => {
    expect(promptPreview({ preview: 'short', textChars: 5, blobKey: null })).toBe('short');
    expect(promptPreview({ preview: 'x'.repeat(160), textChars: 400, blobKey: null })).toBe(`${'x'.repeat(PROMPT_PREVIEW_CHARS)}…`);
    expect(promptPreview({ preview: 'line one\n\nline   two', textChars: 19, blobKey: null })).toBe('line one line two');
    expect(promptPreview({ preview: null, textChars: null, blobKey: KEY_TEXT })).toBe('Stored text');
    expect(promptPreview({ preview: null, textChars: null, blobKey: null })).toBe('(no prompt)');
  });
});
