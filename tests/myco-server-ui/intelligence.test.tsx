/**
 * One run of Myco's work in its panel, and starting a task by hand.
 *
 * The panel leads with what came of the run, then what it read and what it
 * produced, with the technical details folded away; a run with no record of
 * its reads says so and never says it read nothing. "Run a task" confirms
 * each task with this week's real spend, is offered to every member, keeps
 * "Start fresh" for an admin, and words every refusal the server can give.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { LIVE_REFRESH_MS } from '../../packages/myco-server/ui/src/hooks/use-work';
import { dailyLimitWords } from '../../packages/myco-server/ui/src/features/work/words';
import { rawIdsIn } from '../helpers/raw-ids';
import {
  ADMIN, BUILDBOX_ID, HOUR, MEMBER, MEMBERS, MINUTE, NOW, P, PROJECTS, runDetail, S1, S2, sessionAnswer, STUDIO_ID, TASK_RUNS, taskRunsFor, WEEK_SPORES, WEEK_WORK,
} from '../helpers/work-fixture';
import type { WorkAnswer } from '../../packages/myco-server/ui/src/features/today/wire';

const originalFetch = globalThis.fetch;
let client: QueryClient;

beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => {
  cleanup();
  client?.clear();
  globalThis.fetch = originalFetch;
  setSystemTime();
  forgetProject();
});

type Endpoint = (url: URL, init?: RequestInit) => Response;
interface Sent { path: string; body: unknown }

function server(routes: Record<string, Endpoint>): { asked: URL[]; sent: Sent[] } {
  const asked: URL[] = [];
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(url);
    if ((init?.method ?? 'GET') !== 'GET') sent.push({ path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes[url.pathname]?.(url, init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked, sent };
}

const learning = TASK_RUNS['extract-curate']!;
const mapRuns = TASK_RUNS['canopy-map']!;

/** The learning run Lin started, which recorded reading one session and wrote four spores. */
const READ_AND_WROTE = runDetail(learning[2]!, {
  read: { sessions: [{ sessionId: S2, title: 'Flaky test port collision fixed', readAt: NOW - 5 * HOUR - 7 * MINUTE }], total: 1, recorded: true },
  produced: { spores: { total: 4, items: WEEK_SPORES.slice(2, 6).map((s) => ({ id: s.id, observationType: s.observationType, status: 'active', agentLine: s.agentLine, sessionId: S2, createdAt: s.createdAt, runId: 'run_a2c4e6f801' })) } },
  toolCalls: [{ tool: 'myco_run_sessions' }, { tool: 'myco_spores' }, { tool: 'myco_spores', failure: { code: 'refused', message: 'no' } }],
  reports: [{ action: 'summary', summary: 'Saved 4 spores from 1 session.', createdAt: NOW - 5 * HOUR }],
});

const routes = (over: { who?: unknown; detail?: Record<string, () => Response>; work?: WorkAnswer; capabilities?: Record<string, boolean>; dispatch?: Endpoint } = {}): Record<string, Endpoint> => ({
  '/auth/me': () => Response.json(over.who ?? ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/attention': () => Response.json({ items: [], unavailable: [] }),
  '/api/work': () => Response.json(over.work ?? WEEK_WORK),
  '/api/spores': () => Response.json({ spores: WEEK_SPORES, total: WEEK_SPORES.length, maxPage: 200 }),
  [`/api/projects/${P}/runs`]: (url) => Response.json({ rows: TASK_RUNS[url.searchParams.get('task') ?? ''] ?? [], cursor: null }),
  [`/api/projects/${P}/capabilities`]: () => Response.json({ capabilities: over.capabilities ?? { vault_evolution: true, canopy: true, cortex: true } }),
  [`/api/projects/${P}/sessions/${S1}`]: () => Response.json(sessionAnswer(S1, 'Search box height made uniform on list pages')),
  [`/api/projects/${P}/sessions/${S2}`]: () => Response.json(sessionAnswer(S2, 'Flaky test port collision fixed')),
  [`/api/projects/${P}/runs/run_a2c4e6f801`]: () => Response.json(READ_AND_WROTE),
  ...Object.fromEntries(Object.entries(over.detail ?? {}).map(([path, answer]) => [path, () => answer()])),
  '/api/harness/dispatch': over.dispatch ?? (() => Response.json({ runId: 'run_new0000001', projectId: P, queued: true })),
});

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function mount(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Location /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

const location = () => screen.getByTestId('location').textContent;
const panel = () => screen.findByTestId('run-panel');
const rawIdsInPage = (): string[] => rawIdsIn(document.body, ['[data-testid="location"]']);

describe('a run’s panel', () => {
  it('leads with what came of the run, then what it read and produced, all as links, with the details folded away', async () => {
    server(routes());
    mount(`/p/${P}/work/runs/run_a2c4e6f801?window=week`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Learned 4 spores from 1 session');
    expect((await within(open).findByText('started by Lin')).getAttribute('data-started-by')).toBe('');
    expect(open.textContent).toContain('Learning run · Myco');
    // What the run said it did leads, in its own words, right under the headline.
    const report = open.querySelector('[data-run-report]') as HTMLElement;
    expect(report.textContent).toBe('Saved 4 spores from 1 session.');
    expect(report.closest('header')).not.toBeNull();
    expect(open.textContent).toContain('took 5 min');
    const read = within(open).getByRole('region', { name: 'What it read' });
    expect(within(read).getByRole('link', { name: 'Flaky test port collision fixed' }).getAttribute('href')).toBe(`/p/${P}/sessions/${S2}`);
    expect(read.textContent).toContain('4 spores came from it');
    expect(read.querySelector('[data-no-record]')).toBeNull();
    const produced = within(open).getByRole('region', { name: 'What it produced' });
    const spores = within(produced).getAllByRole('link');
    expect(spores).toHaveLength(4);
    expect(spores[0]!.getAttribute('href')).toBe(`/p/${P}/spores/decision-3c4d5e6f`);
    expect(produced.textContent).toContain('4 spores');
    // Technical details start folded: one line says the most of it, and nothing of the facts is drawn.
    const technical = open.querySelector('[data-run-technical]') as HTMLElement;
    expect(technical.textContent).toContain('Ada’s studio Mac · Codex · 20K tokens · $0.50');
    expect(technical.querySelector('[data-facts]')).toBeNull();
    expect(rawIdsInPage()).toEqual([]);
    fireEvent.click(within(technical).getByRole('button', { name: /Technical details/ }));
    const facts = technical.querySelector('[data-facts]') as HTMLElement;
    for (const words of ['Ran onAda’s studio Mac', 'AgentCodex', 'ModelNot recorded for this run', 'Started byLin', 'Tokens20,000', 'The agent’s estimate, not a bill', '3 calls to Myco, 1 refused']) {
      expect(facts.textContent).toContain(words);
    }
    expect(within(facts).getByRole('button', { name: 'Copy run id' })).toBeTruthy();
    expect(technical.textContent).not.toContain('Saved 4 spores from 1 session.');
    // The id is only ever copied: nothing outside the facts shows it.
    expect(rawIdsInPage()).toEqual([]);
  });

  it('names the machine a run ran on to the member it belongs to, and to anyone else as that member’s, never by its id', async () => {
    const linRun = taskRunsFor(MEMBER.member.id)['extract-curate']![2]!;
    server(routes({ who: MEMBER, detail: { [`/api/projects/${P}/runs/run_a2c4e6f801`]: () => Response.json({ ...READ_AND_WROTE, run: { ...READ_AND_WROTE.run, worker: linRun.worker } }) } }));
    mount(`/p/${P}/work/runs/run_a2c4e6f801`);
    const open = await panel();
    await within(open).findByRole('heading', { level: 2 });
    const technical = open.querySelector('[data-run-technical]') as HTMLElement;
    expect(technical.textContent).toContain('Ada’s machine · Codex · 20K tokens · $0.50');
    fireEvent.click(within(technical).getByRole('button', { name: /Technical details/ }));
    const facts = technical.querySelector('[data-facts]')!.textContent!;
    expect(facts).toContain('Ran onAda’s machine');
    expect(open.textContent).not.toContain('Ada’s studio Mac');
    for (const id of [STUDIO_ID, BUILDBOX_ID]) expect(open.textContent).not.toContain(id);
  });

  it('says a run with no record of its reads has none, never that it read nothing', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_7d1e2f3a40`]: () => Response.json(runDetail(TASK_RUNS['title-summary']![0]!, {})) } }));
    mount(`/p/${P}/work/runs/run_7d1e2f3a40`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Titled and summarized a session');
    const read = within(open).getByRole('region', { name: 'What it read' });
    expect(read.querySelector('[data-no-record]')!.textContent).toBe('No record of what it read. Myco didn’t record the sessions this run read, which doesn’t mean it read none.');
    expect(open.textContent).not.toMatch(/read nothing|read no sessions/i);
  });

  it('says a run that recorded its reads and read none didn’t need any sessions', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_c19f7a0e55`]: () => Response.json(runDetail(mapRuns[1]!, { read: { sessions: [], total: 0, recorded: true } })) } }));
    mount(`/p/${P}/work/runs/run_c19f7a0e55`);
    const open = await panel();
    await within(open).findByRole('heading', { level: 2 });
    const read = within(open).getByRole('region', { name: 'What it read' });
    expect(read.querySelector('[data-read-none]')!.textContent).toBe('It didn’t need any sessions.');
    expect(read.querySelector('[data-no-record]')).toBeNull();
  });

  it('lists the sessions a run worked from when it recorded no reads, and says they are not a record', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_4f1c9a2e7b`]: () => Response.json(runDetail(learning[1]!, {
      read: { sessions: [{ sessionId: S1, title: 'Search box height made uniform on list pages', readAt: null }], total: 1, recorded: false },
      produced: { spores: { total: 2, items: WEEK_SPORES.slice(0, 2).map((s) => ({ id: s.id, observationType: s.observationType, status: 'active', agentLine: s.agentLine, sessionId: S1, createdAt: s.createdAt })) } },
      reports: [{ action: 'summary', summary: 'Saved 2 spores from 3 sessions before the turn budget ran out.', createdAt: NOW - 2 * HOUR }],
      run: { error: 'the run exceeded its turn budget' },
    })) } }));
    mount(`/p/${P}/work/runs/run_4f1c9a2e7b`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Learned 2 spores from 1 session');
    expect(open.querySelector('[data-no-record]')!.textContent).toBe('No record of what it read; these are the sessions it worked from.');
    expect(within(open).getByRole('region', { name: 'What it read' }).textContent).toContain('Search box height made uniform on list pages');
    // It failed, but kept what it saved: the cause from its report, and nothing to do.
    const failure = open.querySelector('[data-run-failure]') as HTMLElement;
    expect(failure.textContent).toBe('Why: Saved 2 spores from 3 sessions before the turn budget ran out.What it saved is kept, so there’s nothing to do.');
  });

  it('gives a failed map update its cause from the report, not the stored error, and what to do', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
      reports: [{ action: 'summary', summary: 'repo.sha256 is absent from this checkout, so the previous map is kept.', createdAt: NOW - 3.5 * HOUR }],
      run: { error: 'the run ended without its artifact' },
    })) } }));
    mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Couldn’t update the code map');
    const failure = open.querySelector('[data-run-failure]') as HTMLElement;
    expect(failure.textContent).toContain('Why: repo.sha256 is absent from this checkout, so the previous map is kept.');
    expect(failure.textContent).toContain('Open the run to see where it stopped.');
    // The next step never repeats what the cause already says.
    expect(failure.textContent!.match(/previous map/g)).toHaveLength(1);
    expect(failure.textContent).not.toContain('without its artifact');
    expect(within(open).getByRole('region', { name: 'What it produced' }).textContent).toContain('Nothing; it stopped before writing anything.');
  });

  it('says a held-off run was held off, in words, and a waiting run where it stands, reading it again only while it waits', async () => {
    server(routes({ detail: {
      [`/api/projects/${P}/runs/run_d4e5f6a7b8`]: () => Response.json(runDetail(learning[0]!, {})),
      [`/api/projects/${P}/runs/run_q0000000001`]: () => Response.json(runDetail({ ...learning[2]!, id: 'run_q0000000001', status: 'queued', queuedAt: NOW - MINUTE, position: 2, heldBy: 'concurrent_runs', startedAt: null, completedAt: null, worker: null, startedBy: MEMBER.member.id }, {})),
    } }));
    mount(`/p/${P}/work/runs/run_d4e5f6a7b8`);
    let open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Held off');
    expect(open.textContent).toContain('Myco held off: it was switched off for this project. Nothing ran, and nothing was spent.');
    expect(open.querySelector('[data-run-read]')).toBeNull();
    type Polled = { refetchInterval?: number | false | ((q: unknown) => number | false); refetchIntervalInBackground?: boolean };
    const interval = (runId: string) => {
      const query = client.getQueryCache().find({ queryKey: ['run', P, runId] })!;
      const { refetchInterval, refetchIntervalInBackground } = query.observers[0]!.options as Polled;
      return { interval: typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval, background: refetchIntervalInBackground };
    };
    expect(interval('run_d4e5f6a7b8')).toEqual({ interval: false, background: false });
    cleanup();
    client.clear();
    mount(`/p/${P}/work/runs/run_q0000000001`);
    open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Waiting to start');
    expect(open.querySelector('[data-queued]')!.textContent).toBe('Waiting — 2 ahead of it · held by the limit on runs at once.');
    expect(interval('run_q0000000001')).toEqual({ interval: LIVE_REFRESH_MS, background: false });
  });

  it('closes back to Myco’s work with its filters, and says a run the project doesn’t hold isn’t there', async () => {
    server(routes());
    mount(`/p/${P}/work/runs/run_a2c4e6f801?window=today`);
    const open = await panel();
    fireEvent.click(within(open).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(location()).toBe(`/p/${P}/work?window=today`));
    expect(screen.queryByTestId('run-panel')).toBeNull();
    cleanup();
    client.clear();
    server(routes());
    mount(`/p/${P}/work/runs/run_gone000001`);
    expect(await screen.findByText('This run isn’t in Myco. It may have been cleared out with older runs.')).toBeTruthy();
  });

  it('opens from a run in an outcome’s list, and returns to the page it came from', async () => {
    server(routes());
    mount(`/p/${P}/work?outcome=learn`);
    const runs = await screen.findByRole('list', { name: 'Latest learning runs' });
    const line = [...runs.querySelectorAll('li')].find((li) => li.textContent!.includes('4 spores from 1 session'))!;
    fireEvent.click(within(line).getByRole('link'));
    await panel();
    expect(location()).toBe(`/p/${P}/work/runs/run_a2c4e6f801`);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(location()).toBe(`/p/${P}/work?outcome=learn`));
  });
});

/** Opens "Run a task" and picks one of its tasks, answering the dialog it opens. */
async function startFromMenu(name: RegExp): Promise<HTMLElement> {
  fireEvent.keyDown(await screen.findByRole('button', { name: 'Run a task' }), { key: 'Enter' });
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name }));
  return screen.findByRole('dialog');
}

describe('running a task by hand', () => {
  it('offers every member the tasks, confirms with this week’s real spend, and starts the task as asked, without "Start fresh"', async () => {
    const { sent, asked } = server(routes({ who: MEMBER }));
    mount(`/p/${P}/work`);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Run a task' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Learn from new sessions nowLast ran today at 14:00',
      'Update the code map nowLast ran today at 12:30',
      'Learn from the project’s codeReads the repository for what it holds',
    ]));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Update the code map now/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the code map now?' });
    expect(dialog.textContent).toContain('Myco will read Myco’s repository and update the code map to its latest commit.');
    expect(dialog.textContent).toContain('It runs on the first free machine that has an agent signed in. Recent ones took 4 to 10 minutes.');
    expect(dialog.querySelector('[data-spend]')!.textContent).toBe('This spends model tokens. This week’s updates each used 500K to 2 million tokens, about $1.00 to $2.30 by the agent’s estimate.');
    expect(within(dialog).queryByRole('switch', { name: 'Start fresh' })).toBeNull();
    const reads = asked.filter((url) => url.pathname === '/api/work').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update the code map' }));
    await waitFor(() => expect(sent).toEqual([{ path: '/api/harness/dispatch', body: { projectId: P, task: 'canopy-map' } }]));
    const started = await waitFor(() => { const line = document.querySelector('[data-started]'); if (line === null) throw new Error('not yet'); return line as HTMLElement; });
    expect(started.textContent).toBe('The code map update is queued. It starts on the next free machine.Open the run →');
    expect(within(started).getByRole('link', { name: 'Open the run →' }).getAttribute('href')).toBe(`/p/${P}/work/runs/run_new0000001`);
    expect(screen.queryByRole('dialog')).toBeNull();
    // The page asks again, so the new run shows and the page follows it while it waits.
    await waitFor(() => expect(asked.filter((url) => url.pathname === '/api/work').length).toBeGreaterThan(reads));
    expect(rawIdsInPage()).toEqual([]);
  });

  it('sends one dispatch however fast the confirming button is clicked', async () => {
    let answer: (value: Response) => void = () => undefined;
    const { sent } = server(routes({ dispatch: () => new Promise<Response>((resolve) => { answer = resolve; }) as unknown as Response }));
    mount(`/p/${P}/work`);
    const dialog = await startFromMenu(/Learn from new sessions now/);
    const confirm = within(dialog).getByRole('button', { name: 'Learn now' });
    // Two clicks in one tick, before the page can render the pending state.
    confirm.click();
    confirm.click();
    await waitFor(() => expect(sent).toHaveLength(1));
    answer(Response.json({ runId: 'run_new0000001', projectId: P, queued: true }));
    await waitFor(() => expect(document.querySelector('[data-started]')).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sent).toHaveLength(1);
  });

  it('lets an admin start a task fresh', async () => {
    const { sent } = server(routes());
    mount(`/p/${P}/work`);
    const dialog = await startFromMenu(/Learn from new sessions now/);
    expect(dialog.querySelector('[data-spend]')!.textContent).toBe('This spends model tokens. This week’s learning runs each used 18K to 30K tokens, about $0.50 to $0.96 by the agent’s estimate.');
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Start fresh' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn now' }));
    await waitFor(() => expect(sent).toEqual([{ path: '/api/harness/dispatch', body: { projectId: P, task: 'extract-curate', fresh: true } }]));
  });

  it('starts from the code map card’s "Update now" too, and says when nothing had changed', async () => {
    server(routes({ dispatch: () => Response.json({ outcome: 'unchanged' }) }));
    mount(`/p/${P}/work`);
    fireEvent.click(await screen.findByRole('button', { name: 'Update now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the code map now?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Update the code map' }));
    expect((await screen.findByText('Nothing has changed since the last run, so Myco didn’t start one and spent nothing.')).closest('[data-started]')).not.toBeNull();
    expect(screen.queryByRole('link', { name: 'Open the run →' })).toBeNull();
  });

  it('says when a member’s day of a task is spent, and when they can start it again', async () => {
    const resetsAt = NOW + 2.5 * HOUR;
    server(routes({ who: MEMBER, dispatch: () => Response.json({ error: 'daily_limit', task: 'extract-curate', perDay: 4, resetsAt }, { status: 429, headers: { 'retry-after': '9000' } }) }));
    mount(`/p/${P}/work`);
    const dialog = await startFromMenu(/Learn from new sessions now/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn now' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('You’ve started this task 4 times today; you can again at 18:30.');
    expect(within(dialog).getByRole('button', { name: 'Learn now' }).hasAttribute('disabled')).toBe(true);
    expect([
      dailyLimitWords({ perDay: 1, resetsAt: NOW + 20 * HOUR }, NOW),
      dailyLimitWords({ perDay: 0, resetsAt: null }, NOW),
    ]).toEqual(['You’ve started this task once today; you can again tomorrow at 12:00.', 'Only an admin can start this task on this server.']);
  });

  it('says which capability is switched off, pointing an admin at Project settings and telling a member who can turn it on', async () => {
    const off = () => Response.json({ error: 'capability_off', capability: 'vault_evolution', message: 'this task is turned off for the project' }, { status: 409 });
    server(routes({ dispatch: off }));
    mount(`/p/${P}/work`);
    let dialog = await startFromMenu(/Learn from new sessions now/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn now' }));
    const said = await within(dialog).findByRole('alert');
    expect(said.textContent).toContain('Learning is switched off for this project.');
    expect(within(said).getByRole('link', { name: 'Turn it on in Project settings →' }).getAttribute('href')).toBe(`/p/${P}/settings#capabilities`);
    expect(within(dialog).queryByRole('button', { name: 'Learn now' })).toBeNull();
    cleanup();
    client.clear();
    // Known ahead: the menu says so, and the confirmation says it in place of starting anything.
    const { sent } = server(routes({ who: MEMBER, capabilities: { vault_evolution: false, canopy: true } }));
    mount(`/p/${P}/work`);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'Run a task' }), { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    await waitFor(() => expect(within(menu).getAllByRole('menuitem')[0]!.textContent).toBe('Learn from new sessions nowLearning is switched off for this project.'));
    fireEvent.click(within(menu).getAllByRole('menuitem')[0]!);
    dialog = await screen.findByRole('dialog');
    const offLine = dialog.querySelector('[data-capability-off]') as HTMLElement;
    expect(offLine.textContent).toBe('Learning is switched off for this project.An admin can turn it on in the project’s settings.');
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Learn now' })).toBeNull();
    expect(sent).toEqual([]);
  });

  it('words a fresh start refused to a member, and any other refusal by its status, never the server\'s sentence', async () => {
    let answer: Response = Response.json({ error: 'fresh_needs_admin' }, { status: 403 });
    server(routes({ who: MEMBER, dispatch: () => answer }));
    mount(`/p/${P}/work`);
    const dialog = await startFromMenu(/Learn from the project’s code/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn from the code' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Only an admin can start a task fresh.');
    // A 403 that is not about starting fresh is not worded as one.
    answer = Response.json({ error: 'forbidden', reason: 'this account can’t start tasks here' }, { status: 403 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn from the code' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('The server couldn’t start it (403). Try again in a moment.'));
    answer = Response.json({ error: 'bad_request', reason: 'no agent is configured for this task' }, { status: 400 });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn from the code' }));
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('The server couldn’t start it (400). Try again in a moment.'));
    // No run this week spent anything on it, so the confirmation says there is nothing to go by.
    expect(dialog.querySelector('[data-spend]')!.textContent).toBe('This spends model tokens. No runs over the code finished this week, so there’s no recent spend to go by.');
  });

  it('never shows a menu when the page spans every project', async () => {
    server(routes());
    mount('/work');
    await screen.findByRole('heading', { level: 1, name: 'Myco’s work' });
    await waitFor(() => expect(document.querySelector('article[data-outcome]')).not.toBeNull());
    expect(screen.queryByRole('button', { name: 'Run a task' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update now' })).toBeNull();
  });
});


for (const [code, sentence] of [
  ['machine_did_not_start', 'No machine started the task within a day.'],
  ['machine_unresponsive', 'The machine running it stopped responding.'],
  ['task_start_failed', 'The machine could not start the task.'],
  ['run_failed', 'The task stopped before it could finish.'],
  [undefined, 'The task stopped before it could finish.'],
  ['unknown_code', 'The task stopped before it could finish.'],
] as const) {
  it(`words a ${code ?? 'legacy'} failure in the panel and its details without quoting the error`, async () => {
    const prose = 'server prose must stay off the page';
    server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
      reports: [], run: { errorCode: code, error: prose },
    })) } }));
    mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
    const open = await panel();
    await waitFor(() => expect(open.querySelector('[data-run-failure]')?.textContent).toContain(sentence));
    fireEvent.click(within(open).getByRole('button', { name: /Technical details/ }));
    expect(open.querySelector('[data-run-technical]')!.textContent).toContain(sentence);
    expect(document.body.textContent).not.toContain(prose);
  });
}

it('words a free-text skip from its fallback code', async () => {
  server(routes({ detail: { [`/api/projects/${P}/runs/run_d4e5f6a7b8`]: () => Response.json(runDetail(learning[0]!, {
    run: { skipReason: 'server prose must stay off the page', skipReasonCode: 'run_not_needed' },
  })) } }));
  mount(`/p/${P}/work/runs/run_d4e5f6a7b8`);
  const open = await panel();
  await waitFor(() => expect(open.textContent).toContain('Myco didn’t need to run it'));
  expect(open.textContent).not.toContain('server prose must stay off the page');
});


it('words a task no machine started from its code', async () => {
  server(routes({ detail: { [`/api/projects/${P}/runs/run_d4e5f6a7b8`]: () => Response.json(runDetail(learning[0]!, {
    run: { skipReason: 'server prose must stay off the page', skipReasonCode: 'machine_did_not_start' },
  })) } }));
  mount(`/p/${P}/work/runs/run_d4e5f6a7b8`);
  const open = await panel();
  await waitFor(() => expect(open.textContent).toContain('no machine started it within a day'));
  expect(open.textContent).not.toContain('server prose must stay off the page');
});
