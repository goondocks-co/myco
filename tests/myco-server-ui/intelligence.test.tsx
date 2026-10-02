import { TASK_DESCRIPTIONS } from './task-fixture';
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
import { dailyLimitWords, failureWords } from '../../packages/myco-server/ui/src/features/work/words';
import { EFFORT_UNAPPLIED } from '@goondocks/myco-shared/execution-profile';
import { rawIdsIn } from '../helpers/raw-ids';
import {
  ADMIN, BUILDBOX_ID, HOUR, MEMBER, MEMBERS, MINUTE, NOW, P, PROJECTS, runDetail, S1, S2, sessionAnswer, STUDIO_ID, TASK_RUNS, taskRunsFor, WEEK_SPORES, WEEK_WORK,
} from '../helpers/work-fixture';
import type { WorkAnswer } from '../../packages/myco-server/ui/src/features/today/wire';
import { ModelSummary } from '../../packages/myco-server/ui/src/features/work/ModelSummary';
import { RunPanel } from '../../packages/myco-server/ui/src/features/work/RunPanel';
import { RUN_TOOL_MAP } from '../../packages/myco-server/src/mcp/run-surface';
import { MECHANISM_WORDS, RETIRED_VOCABULARY } from '../helpers/reader-vocabulary';

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
  toolCalls: [{ id: 1, status: 'success', tool: 'myco_run_sessions', op: 'get', recordedAt: NOW, durationMs: 10 }, { id: 2, status: 'success', tool: 'myco_spores', op: 'save', recordedAt: NOW, durationMs: 20 }, { id: 3, status: 'failed', tool: 'myco_spores', op: 'save', recordedAt: NOW, durationMs: 10, failure: { code: 'refused', message: 'no' } }],
  reports: [{ action: 'summary', details: null, summary: 'Saved 4 spores from 1 session.', createdAt: NOW - 5 * HOUR }],
});

const routes = (over: { who?: unknown; detail?: Record<string, () => Response>; work?: WorkAnswer; capabilities?: Record<string, boolean>; dispatch?: Endpoint } = {}): Record<string, Endpoint> => ({
  '/auth/me': () => Response.json(over.who ?? ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/attention': () => Response.json({ items: [], unavailable: [] }),
  '/api/tasks': () => Response.json({ tasks: TASK_DESCRIPTIONS }),
  '/api/tasks/names': () => Response.json({ tasks: TASK_DESCRIPTIONS.map(({ task, name }) => ({ task, name })) }),
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
    // The report is attributed once in its own section.
    const report = open.querySelector('[data-run-report]') as HTMLElement;
    expect(report.textContent).toBe('Saved 4 spores from 1 session.');
    expect(report.closest('header')).toBeNull();
    expect(within(open).getByRole('region', { name: 'The agent’s report' }).textContent).toContain(report.textContent);
    expect(open.textContent).toContain('took 5 min');
    const read = within(open).getByRole('region', { name: 'Sessions it read' });
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
    for (const words of ['Ran onAda’s studio Mac', 'AgentCodex', 'Model not recorded', 'Started byLin', 'Tokens20,000', 'Cost provenance not recorded']) {
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
    const read = within(open).getByRole('region', { name: 'Sessions it read' });
    expect(read.querySelector('[data-no-record]')!.textContent).toBe('No session reads were recorded. This does not mean it read no sessions.');
    expect(read.textContent).not.toMatch(/^It read nothing|^It read no sessions/i);
  });

  it('says a run that recorded its reads and read none didn’t need any sessions', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_c19f7a0e55`]: () => Response.json(runDetail(mapRuns[1]!, { run: { task: 'title-summary' }, read: { sessions: [], total: 0, recorded: true } })) } }));
    mount(`/p/${P}/work/runs/run_c19f7a0e55`);
    const open = await panel();
    await within(open).findByRole('heading', { level: 2 });
    const read = within(open).getByRole('region', { name: 'Sessions it read' });
    expect(read.querySelector('[data-read-none]')!.textContent).toBe('It didn’t need any sessions.');
    expect(read.querySelector('[data-no-record]')).toBeNull();
  });

  it('lists the sessions a run worked from when it recorded no reads, and says they are not a record', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_4f1c9a2e7b`]: () => Response.json(runDetail(learning[1]!, {
      read: { sessions: [{ sessionId: S1, title: 'Search box height made uniform on list pages', readAt: null }], total: 1, recorded: false },
      produced: { spores: { total: 2, items: WEEK_SPORES.slice(0, 2).map((s) => ({ id: s.id, observationType: s.observationType, status: 'active', agentLine: s.agentLine, sessionId: S1, createdAt: s.createdAt })) } },
      reports: [{ action: 'summary', details: null, summary: 'Saved 2 spores from 3 sessions before the turn budget ran out.', createdAt: NOW - 2 * HOUR }],
      run: { error: 'the run exceeded its turn budget' },
    })) } }));
    mount(`/p/${P}/work/runs/run_4f1c9a2e7b`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('Failed with output kept');
    expect(open.querySelector('[data-no-record]')!.textContent).toBe('No session reads were recorded; these are the sessions it worked from.');
    expect(within(open).getByRole('region', { name: 'Sessions it read' }).textContent).toContain('Search box height made uniform on list pages');
    // Terminal failure and retained output are shown independently.
    const failure = open.querySelector('[data-run-failure]') as HTMLElement;
    expect(failure.textContent).toBe('Run failure: The task stopped before it could finish.What it saved is kept.');
  });

  it('keeps a failed map update’s terminal error separate from its report', async () => {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
      reports: [{ action: 'summary', details: null, summary: 'repo.sha256 is absent from this checkout, so the previous map is kept.', createdAt: NOW - 3.5 * HOUR }],
      run: { error: 'the run ended without its artifact' },
    })) } }));
    mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
    const open = await panel();
    expect((await within(open).findByRole('heading', { level: 2 })).textContent).toBe('This run failed');
    const failure = open.querySelector('[data-run-failure]') as HTMLElement;
    expect(failure.textContent).toContain('Run failure: The task stopped before it could finish.');
    expect(failure.textContent).toContain('Open the run to see where it stopped.');
    // The next step never repeats what the cause already says.
    expect(open.querySelector('[data-run-report]')!.textContent).toContain('previous map');
    expect(failure.textContent).not.toContain('repo.sha256');
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
      `Learn from the project’s code${TASK_DESCRIPTIONS.find((task) => task.task === 'vault-seed')!.description}`,
    ]));
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Update the code map now/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Update the code map now?' });
    expect(dialog.textContent).toContain(TASK_DESCRIPTIONS.find((task) => task.task === 'canopy-map')!.description);
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
  ['model_not_applied', 'The agent couldn’t use the chosen model.'],
  ['report_without_audit', 'The agent didn’t account for the steps it took, so its work couldn’t be checked.'],
  ['run_failed', 'The task stopped before it could finish.'],
  [undefined, 'The task stopped before it could finish.'],
  ['unknown_code', 'The task stopped before it could finish.'],
] as const) {
  it(`words a ${code ?? 'legacy'} failure with its specific reason available in details`, async () => {
    const prose = code === 'unknown_code' ? 'runtime output reported a missing file' : 'The saved output could not be read.';
    server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
      reports: [], run: { errorCode: code, error: prose },
    })) } }));
    mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
    const open = await panel();
    await waitFor(() => expect(open.querySelector('[data-run-failure]')?.textContent).toContain(sentence));
    expect(open.textContent).not.toContain(prose);
    fireEvent.click(within(open.querySelector<HTMLElement>('[data-run-technical]')!).getByRole('button', { name: /Technical details/ }));
    expect(open.querySelector('[data-run-technical]')!.textContent).toContain(sentence);
    expect(open.querySelector('[data-run-technical]')!.textContent).toContain(prose);
  });
}

it('words a run whose agent could not use the chosen model from the reason it recorded, and keeps the worker\'s record in details', async () => {
  const raw = 'the harness stopped: error (profile_unapplied: it kept the effort (none) after being set to high (Invalid (params)))';
  const reason = 'it kept the effort (none) after being set to high';
  const sentence = `The agent couldn’t use the chosen model: ${reason}.`;
  server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
    reports: [], run: { errorCode: 'model_not_applied', errorReason: reason, error: raw },
  })) } }));
  mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
  const open = await panel();
  await waitFor(() => expect(open.querySelector('[data-run-failure]')?.textContent).toContain(sentence));
  expect(open.textContent).not.toContain('profile_unapplied');
  expect(MECHANISM_WORDS.test(open.querySelector('[data-run-failure]')!.textContent ?? '')).toBe(false);
  fireEvent.click(within(open.querySelector<HTMLElement>('[data-run-technical]')!).getByRole('button', { name: /Technical details/ }));
  expect(open.querySelector('[data-run-technical]')!.textContent).toContain(raw);
  expect(failureWords({ source: 'error', code: 'model_not_applied', reason, cause: raw, error: raw })).toBe(sentence);
  // With no recorded reason, the sentence stands alone: the error's text is never read for one.
  expect(failureWords({ source: 'error', code: 'model_not_applied', cause: raw, error: raw })).toBe('The agent couldn’t use the chosen model.');
});

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


it('keeps a coded failure as the headline when the run also filed a report', async () => {
  const reason = 'The saved output could not be read.';
  const report = 'The machine reported a missing file.';
  server(routes({ detail: { [`/api/projects/${P}/runs/run_5e0b1c2d3f`]: () => Response.json(runDetail(mapRuns[0]!, {
    reports: [{ action: 'summary', details: null, summary: report, createdAt: NOW }],
    run: { errorCode: 'machine_unresponsive', error: reason },
  })) } }));
  mount(`/p/${P}/work/runs/run_5e0b1c2d3f`);
  const open = await panel();
  await waitFor(() => expect(open.querySelector('[data-run-failure]')!.textContent).toContain('The machine running it stopped responding.'));
  expect(open.textContent).not.toContain(reason);
  expect(open.querySelector('[data-run-report]')!.textContent).toContain(report);
  fireEvent.click(within(open.querySelector<HTMLElement>('[data-run-technical]')!).getByRole('button', { name: /Technical details/ }));
  expect(open.querySelector('[data-run-technical]')!.textContent).toContain(reason);
  expect(open.querySelector('[data-run-technical]')!.textContent).not.toContain(report);
});

describe('stored run audit evidence', () => {
  const audit = () => runDetail(mapRuns[1]!, {
    run: {
      requested: { tier: 'high', model: 'opus', effort: 'high', sources: { tier: 'task', model: 'default' } },
      identity: { status: 'reported', source: 'result', primary: { model: 'claude-sonnet-4-6' }, models: [{ model: 'claude-sonnet-4-6', source: 'result', usage: null }] },
      instruction: 'Examine this pinned repository.\nKeep the launch prompt exactly.',
      instructions: 'One bounded line per map entry.\nDo not change repository files.',
    },
    reports: [{ action: 'canopy_map', summary: 'Updated the map.', details: '{"examined":"src/core","recovery":"corrected the map text"}', createdAt: NOW }],
    toolCalls: [
      { id: 1, status: 'success', tool: 'myco_run_map', op: 'get', recordedAt: NOW - 4 * MINUTE, durationMs: 38 },
      { id: 2, status: 'failed', tool: 'myco_run_map', op: 'write', recordedAt: NOW - 3 * MINUTE, durationMs: 10, failure: { code: 'tool_failure', message: 'Map text must be a bounded nonempty line.' } },
      { id: 3, status: 'success', tool: 'myco_run_map', op: 'write', recordedAt: NOW - 2 * MINUTE, durationMs: 117 },
      { id: 4, status: 'success', tool: 'myco_run', op: 'report', recordedAt: NOW - MINUTE, durationMs: 40 },
    ],
  });
  async function openAudit(answer = audit()) {
    server(routes({ detail: { [`/api/projects/${P}/runs/run_c19f7a0e55`]: () => Response.json(answer) } }));
    mount(`/p/${P}/work/runs/run_c19f7a0e55`);
    const open = await panel();
    await within(open).findByRole('heading', { level: 2 });
    return open;
  }
  it('shows four calls in order, the exact validation failure and its later successful correction', async () => {
    const open = await openAudit();
    const calls = within(open).getByRole('region', { name: 'What it did' });
    const rows = within(calls).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toContain('Map text must be a bounded nonempty line.');
    expect(rows[1]!.textContent).toContain('Failed');
    expect(rows[2]!.textContent).toContain('Succeeded');
    expect(rows[2]!.textContent).toContain('117 ms');
    expect(calls.textContent).not.toContain('refused');
  });
  it('renders requested and actual models and flags a mismatch in the summary', async () => {
    const open = await openAudit();
    const summary = open.querySelector('header')!;
    expect(summary.textContent).toContain('Requested: high · opus · high effort');
    expect(summary.textContent).toContain('Actual: claude-sonnet-4-6');
    expect(summary.textContent).toContain('Ran a different model than requested');
  });
  it('shows the exact stored instruction and standing rules behind a disclosure', async () => {
    const open = await openAudit();
    fireEvent.click(within(open).getByRole('button', { name: 'Instruction at launch' }));
    expect(open.textContent).toContain(audit().run.instruction);
    expect(open.textContent).toContain(audit().run.instructions);
  });
  it('renders a single report’s supporting details', async () => {
    const open = await openAudit();
    fireEvent.click(within(open).getByRole('button', { name: 'Report details' }));
    expect(open.textContent).toContain('"recovery":"corrected the map text"');
  });
  it('keeps a terminal failure distinct from a successful agent report and keeps output', async () => {
    const answer = audit();
    answer.run.status = 'failed';
    answer.run.error = 'Worker exceeded the execution budget.';
    answer.run.result = 'failed_with_output';
    const open = await openAudit(answer);
    expect(open.querySelector('[data-run-headline]')!.textContent).toBe('Failed with output kept');
    expect(open.querySelector('[data-run-failure]')!.textContent).toContain('The task stopped before it could finish.');
    fireEvent.click(within(open.querySelector<HTMLElement>('[data-run-technical]')!).getByRole('button', { name: /Technical details/ }));
    expect(open.querySelector('[data-run-technical]')!.textContent).toContain('Worker exceeded the execution budget.');
    expect(open.querySelector('[data-run-report]')!.textContent).toContain('Updated the map.');
  });
  for (const task of ['canopy-map', 'title-summary']) {
    it(`${task} with no write says checked and changed nothing`, async () => {
      const answer = audit();
      answer.run.task = task;
      answer.run.result = 'unchanged';
      const open = await openAudit(answer);
      expect(open.querySelector('[data-run-headline]')!.textContent).toBe('Checked and changed nothing');
      expect(within(open).getByRole('region', { name: 'What it produced' }).textContent).not.toMatch(/brought up|A title and summary/);
    });
  }
});

it('reads every page of a run’s 201 calls, then lists them a page at a time with the true total', async () => {
  const first = runDetail(mapRuns[1]!, {
    toolCalls: Array.from({ length: 200 }, (_, i) => ({ id: i, status: 'success' as const, tool: 'myco_run_map', op: 'get', recordedAt: NOW + i, durationMs: 10 })),
    toolCallCoverage: { total: 201, failed: 0, cursor: 'next-page' },
  });
  const last = runDetail(mapRuns[1]!, { toolCalls: [{ id: 200, status: 'unknown', tool: 'myco_run', op: 'report', recordedAt: NOW, durationMs: null }], toolCallCoverage: { total: 201, failed: 0, cursor: null } });
  const { asked } = server({ ...routes(), [`/api/projects/${P}/runs/run_c19f7a0e55`]: () => Response.json(first), [`/api/projects/${P}/runs/run_c19f7a0e55/calls`]: () => Response.json({ ...last.toolCallCoverage, rows: last.toolCalls }) });
  mount(`/p/${P}/work/runs/run_c19f7a0e55`);
  const open = await panel();
  const calls = await within(open).findByRole('region', { name: 'What it did' });
  await waitFor(() => expect(calls.textContent).toContain('Showing 200 of 201 calls'));
  expect(within(calls).getAllByRole('listitem')).toHaveLength(200);
  fireEvent.click(within(calls).getByRole('button', { name: 'Show more' }));
  await waitFor(() => expect(within(calls).getAllByRole('listitem')).toHaveLength(201));
  expect(calls.textContent).toContain('Showing 201 of 201 calls');
  expect(within(calls).getAllByRole('listitem').at(-1)!.textContent).toContain('Status not recorded');
  expect(asked.some((url) => url.pathname.endsWith('/calls') && url.searchParams.get('cursor') === 'next-page' && url.searchParams.get('limit') === '200')).toBe(true);
  expect(asked.filter((url) => url.pathname.endsWith('/runs/run_c19f7a0e55'))).toHaveLength(1);
});

describe('reviewed run evidence', () => {
  async function openReviewed(over: Parameters<typeof runDetail>[1] = {}) {
    const answer = runDetail(mapRuns[1]!, over);
    server(routes({ detail: { [`/api/projects/${P}/runs/run_c19f7a0e55`]: () => Response.json(answer) } }));
    mount(`/p/${P}/work/runs/run_c19f7a0e55`);
    const open = await panel();
    await within(open).findByRole('heading', { level: 2 });
    return open;
  }
  it('uses reader words for every known run operation and keeps identifiers folded away', async () => {
    const pairs = [...new Map(Object.values(RUN_TOOL_MAP).flat().map((pair) => [`${pair.tool}/${pair.op}`, pair])).values()];
    const open = await openReviewed({ toolCalls: [...pairs.map((pair, i) => ({ id: i, status: 'success' as const, tool: pair.tool, op: pair.op, recordedAt: NOW, durationMs: 10 })), { id: pairs.length, status: 'success', tool: 'myco_future_runtime', op: 'credential', recordedAt: NOW, durationMs: 10 }] });
    const activity = within(open).getByRole('region', { name: 'What it did' });
    const rows = within(activity).getAllByRole('listitem');
    expect(rows).toHaveLength(pairs.length + 1);
    for (const row of rows) {
      expect(row.textContent).not.toMatch(MECHANISM_WORDS);
      expect(row.textContent).not.toMatch(RETIRED_VOCABULARY);
      expect(row.textContent).not.toContain('myco_');
    }
    expect(activity.textContent).toContain('Read the code map');
    expect(activity.textContent).toContain('Wrote the code map');
    expect(activity.textContent).toContain('Read session material');
    expect(activity.textContent).toContain('Reported');
    expect(rows.at(-1)!.textContent).toContain('Called Myco');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Technical details' }));
    expect(rows[0]!.textContent).toContain(pairs[0]!.tool);
  });
  for (const task of ['canopy-map', 'vault-seed']) {
    it(`names the pinned repository source for ${task} rather than session reads`, async () => {
      const open = await openReviewed({ run: { task }, source: { branch: 'audit-source', commit: 'a'.repeat(40) } });
      const read = within(open).getByRole('region', { name: 'What it read' });
      expect(read.textContent).toContain('Which files it read isn’t recorded: Myco kept no step log for this run. This doesn’t mean it read none.');
      expect(read.textContent).toContain('It worked from audit-source @ aaaaaaa.');
      expect(within(open).queryByRole('region', { name: 'Sessions it read' })).toBeNull();
    });
  }
  it('names an unrecorded repository source plainly', async () => {
    const open = await openReviewed({ source: null });
    expect(within(open).getByRole('region', { name: 'What it read' }).textContent).toContain("The source it read wasn't recorded.");
  });
  for (const harness of [null, 'claude-code']) {
    it(`does not flag the sonnet alias as a mismatch when harness is ${harness}`, () => {
      const run = runDetail(mapRuns[1]!, { run: { harness, requested: { tier: 'high', model: 'sonnet', effort: 'high', sources: { tier: 'task', model: 'default' } }, identity: { status: 'reported', source: 'result', primary: { model: 'claude-sonnet-5-5' }, models: [{ model: 'claude-sonnet-5-5', source: 'result', usage: null }] } } }).run;
      const { container } = render(<ModelSummary run={run} />);
      expect(container.querySelector('[data-model-mismatch]')).toBeNull();
    });
  }
  it('lists a failed run’s report once and labels who said it', async () => {
    const open = await openReviewed({ run: { status: 'failed', result: 'failed_with_output' }, reports: [{ action: 'canopy_map', summary: 'I saved one map.', details: null, createdAt: NOW }] });
    expect(within(open).getAllByText('I saved one map.')).toHaveLength(1);
    const report = within(open).getByRole('region', { name: 'The agent’s report' });
    expect(report.textContent).toContain('The agent said:');
    expect(open.querySelector('header')!.textContent).not.toContain('I saved one map.');
  });
  it('hides a credential-shaped canary in the stored launch prompt', async () => {
    const canary = `sk-proj-${'Q'.repeat(40)}`;
    const budgets = 'Keep max_tokens=4096 and token_budget: 12000; token_limit=8000.';
    const open = await openReviewed({ run: { instruction: `Use this access key: ${canary}\nKeep map entries bounded.\n${budgets}` } });
    fireEvent.click(within(open).getByRole('button', { name: 'Instruction at launch' }));
    expect(open.textContent).not.toContain(canary);
    expect(open.textContent).toContain('Keep map entries bounded.');
    expect(open.textContent).toContain(budgets);
    expect(open.textContent).toContain('Access keys and passwords are hidden.');
  });
  it('says when the agent offered no effort setting for the model a run used, and nothing when it applied one (#1608)', () => {
    const base = { harness: 'opencode', requested: { tier: 'low', model: 'opencode/big-pickle', effort: 'medium', sources: { tier: 'task', model: 'configured' } } } as const;
    const identity = (warnings?: string[]) => ({ status: 'reported', source: 'session.configOptions', primary: { model: 'big-pickle', provider: 'opencode' }, models: [{ model: 'big-pickle', provider: 'opencode', source: 'session.configOptions', usage: null }], ...(warnings === undefined ? {} : { warnings }) });
    for (const variant of ['summary', 'list', 'details'] as const) {
      const skipped = render(<ModelSummary run={runDetail(mapRuns[1]!, { run: { ...base, identity: identity([EFFORT_UNAPPLIED]) } }).run} variant={variant} />);
      expect(skipped.container.querySelector('[data-effort-unapplied]')?.textContent).toBe('Effort not applied: the agent offered no effort setting for this model');
      expect(skipped.container.querySelector('[data-model-mismatch]')).toBeNull();
      skipped.unmount();
      const applied = render(<ModelSummary run={runDetail(mapRuns[1]!, { run: { ...base, identity: identity() } }).run} variant={variant} />);
      expect(applied.container.querySelector('[data-effort-unapplied]')).toBeNull();
      applied.unmount();
    }
  });
  it('never flags an OpenRouter alias run that reported another model as mismatched with nothing to judge it by: it says the model is unconfirmed', () => {
    const alias = 'openrouter/~openai/gpt-sol-latest';
    const ran = (model: string) => ({ status: 'reported', source: 'session.configOptions', primary: { model, provider: 'openrouter' }, models: [{ model, provider: 'openrouter', source: 'session.configOptions', usage: null }] });
    const shown = (resolvesTo: string | undefined, model: string): { mismatch: boolean; unconfirmed: string | null } => {
      const requested = { tier: 'default', model: alias, effort: null, sources: { tier: 'task', model: 'configured' }, ...(resolvesTo === undefined ? {} : { resolvesTo }) };
      const view = render(<ModelSummary run={runDetail(mapRuns[1]!, { run: { harness: 'opencode', requested, identity: ran(model) } }).run} />);
      const seen = { mismatch: view.container.querySelector('[data-model-mismatch]') !== null, unconfirmed: view.container.querySelector('[data-model-unconfirmed]')?.textContent ?? null };
      view.unmount();
      return seen;
    };
    expect(shown(undefined, '~openai/gpt-sol-latest')).toEqual({ mismatch: false, unconfirmed: null });
    expect(shown(undefined, 'openai/gpt-6.1-sol')).toEqual({ mismatch: false, unconfirmed: 'Can’t confirm the model: the provider chooses which model this name runs' });
    expect(shown('openrouter/openai/gpt-6.1-sol', 'openai/gpt-6.1-sol')).toEqual({ mismatch: false, unconfirmed: null });
    expect(shown('openrouter/openai/gpt-6.1-sol', 'openai/gpt-6-luna')).toEqual({ mismatch: true, unconfirmed: null });
  });
  it('omits empty model evidence from run lists', () => {
    const { container } = render(<ModelSummary run={runDetail(mapRuns[1]!).run} variant="list" />);
    expect(container.textContent).toBe('');
  });
  it('lists requested and actual models on one line with reader mismatch words', () => {
    const run = runDetail(mapRuns[1]!, { run: { harness: 'claude-code', requested: { tier: 'high', model: 'opus', effort: 'high', sources: { tier: 'task', model: 'default' } }, identity: { status: 'reported', source: 'result', primary: { model: 'claude-sonnet-4-6' }, models: [{ model: 'claude-sonnet-4-6', source: 'result', usage: null }] } } }).run;
    const { container } = render(<ModelSummary run={run} variant="list" />);
    expect(container.textContent).toContain('Asked for Opus, high effort · ran claude-sonnet-4-6');
    expect(container.textContent).toContain('Ran a different model than requested');
    expect(container.textContent).not.toContain('Not recorded');
  });
});

it('links the registry task name in a run panel to its task card', async () => {
  const { asked } = server({ ...routes(), '/api/tasks/names': () => Response.json({ tasks: [{ task: 'extract-curate', name: 'Learning from the task registry' }] }) });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter><RunPanel projectId={P} runId="run_a2c4e6f801" projectName="Myco" now={NOW} onClose={() => {}} /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
  const open = await panel();
  const link = await within(open).findByRole('link', { name: 'Learning from the task registry →' });
  expect(link.getAttribute('href')).toBe(`/p/${P}/work/tasks#extract-curate`);
  expect(asked.some((url) => url.pathname === '/api/tasks/names' && url.searchParams.get('project') === P)).toBe(true);
  expect(asked.some((url) => url.pathname === '/api/tasks')).toBe(false);
});

it('uses the registry description when confirming a task', async () => {
  const description = 'The server’s changed declaration is shown before starting this task.';
  server({ ...routes(), '/api/tasks': () => Response.json({ tasks: TASK_DESCRIPTIONS.map((task) => task.task === 'vault-seed' ? { ...task, description } : task) }) });
  mount(`/p/${P}/work`);
  const dialog = await startFromMenu(/Learn from the project’s code/);
  await waitFor(() => expect(dialog.textContent).toContain(description));
});
