/**
 * Myco's work: what Myco's own runs came to, grouped by outcome, each failure
 * beside the outcome it belongs to, search upkeep as one line, the cost rail,
 * the filters in the URL, polling only while a run is still to finish, the
 * page across every project, and the Agent runs addresses leading here.
 *
 * The clock is held at a fixed afternoon so every instant sits on the day it names.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { LIVE_REFRESH_MS } from '../../packages/myco-server/ui/src/hooks/use-work';
import { costOf, summarize } from '../../packages/myco-server/ui/src/features/work/outcomes';
import { outcomeHeadline, runLineWords, skipWords, spendWords, startedByWords } from '../../packages/myco-server/ui/src/features/work/words';
import { workBounds } from '../../packages/myco-server/ui/src/features/work/WorkPage';
import { rawIdsIn } from '../helpers/raw-ids';
import {
  ADMIN, BUILDBOX_ID, HOUR, MEMBER, MEMBERS, MINUTE, NOW, outcome, P, P2, PROJECTS, runRow, S1, S2, sessionAnswer, STUDIO_ID, TASK_RUNS, taskRunsFor, TODAY, WEEK, WEEK_SPORES, WEEK_WORK, workRun,
} from '../helpers/work-fixture';
import type { WorkAnswer } from '../../packages/myco-server/ui/src/features/today/wire';

const originalFetch = globalThis.fetch;
let client: QueryClient;

it('uses the skip code in a run list instead of the server reason', () => {
  expect(runLineWords(null, { status: 'skipped', skipReasonCode: 'machine_did_not_start', skipReason: 'server prose must stay off the page', targetSessionId: null }, { spores: 0, sessions: 0, readsRecorded: false }))
    .toBe('Held off: no machine started it within a day');
});

beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => {
  cleanup();
  client?.clear();
  globalThis.fetch = originalFetch;
  setSystemTime();
  forgetProject();
});

type Routes = Record<string, (url: URL) => Response>;

/** Answers by path from `routes`, else 404, and records every URL asked. */
function server(routes: Routes): URL[] {
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(url);
    return routes[url.pathname]?.(url) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return asked;
}

const week = (over: { work?: WorkAnswer; who?: unknown; taskRuns?: typeof TASK_RUNS } = {}): Routes => ({
  '/auth/me': () => Response.json(over.who ?? ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/work': () => Response.json(over.work ?? WEEK_WORK),
  '/api/spores': () => Response.json({ spores: WEEK_SPORES, total: WEEK_SPORES.length, maxPage: 200 }),
  [`/api/projects/${P}/runs`]: (url) => Response.json({ rows: (over.taskRuns ?? taskRunsFor(((over.who ?? ADMIN) as typeof ADMIN).member.id))[url.searchParams.get('task') ?? ''] ?? [], cursor: null }),
  [`/api/projects/${P}/capabilities`]: () => Response.json({ capabilities: { vault_evolution: true, canopy: true, cortex: true } }),
  [`/api/projects/${P}/sessions/${S1}`]: () => Response.json(sessionAnswer(S1, 'Search box height made uniform on list pages')),
  [`/api/projects/${P}/sessions/${S2}`]: () => Response.json(sessionAnswer(S2, 'Flaky test port collision fixed')),
});

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function mount(path: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <AppearanceProvider>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Location />
        </MemoryRouter>
      </QueryClientProvider>
    </AppearanceProvider>,
  );
}

const card = (kind: string) => document.querySelector(`article[data-outcome="${kind}"]`) as HTMLElement;
/** The card once it renders. */
const findCard = (kind: string) => waitFor(() => { const found = card(kind); if (found === null) throw new Error(`no ${kind} card yet`); return found; });
const location = () => screen.getByTestId('location').textContent;
/** Visible text carrying a raw id, outside a facts panel and the test's own location probe. */
const rawIdsInPage = (): string[] => rawIdsIn(document.body, ['[data-testid="location"]']);

describe('what Myco’s work came to', () => {
  it('sums each kind of work across projects: outcomes, failures, recoveries, spend and cost', () => {
    const answer: WorkAnswer = {
      ...WEEK_WORK,
      outcomes: [
        ...WEEK_WORK.outcomes,
        outcome({ projectId: P2, kind: 'learn', task: 'extract-curate', runs: { completed: 1, queued: 1 }, outcome: { spores: 3, sessions: 2, maps: 0 }, latestAt: NOW - MINUTE, tokens: 10_000, costUsd: 0.25, runsWithoutCost: 1, spend: { tokens: [10_000, 12_000], costUsd: [0.2, 1.4], durationMs: [MINUTE, 20 * MINUTE] } }),
      ],
      runs: [...WEEK_WORK.runs, workRun({ id: 'run_map0000new', kind: 'map', task: 'canopy-map', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 1 } })],
    };
    const [learn, title, map] = summarize(answer);
    expect([learn!.kind, title!.kind, map!.kind]).toEqual(['learn', 'title', 'map']);
    expect({ spores: learn!.spores, sessions: learn!.sessions, finished: learn!.finished, produced: learn!.produced, projects: learn!.projects, latestAt: learn!.latestAt })
      .toEqual({ spores: 9, sessions: 6, finished: 4, produced: 4, projects: [P, P2], latestAt: NOW - MINUTE });
    expect(learn!.spend).toEqual({ tokens: [10_000, 30_000], costUsd: [0.2, 1.4], durationMs: [MINUTE, 20 * MINUTE] });
    expect(learn!.kept.map((run) => run.id)).toEqual(['run_4f1c9a2e7b']);
    expect(learn!.failures).toEqual([]);
    // A map update that failed and was followed by one that worked has recovered.
    expect(map!.failures.map((run) => run.id)).toEqual(['run_5e0b1c2d3f']);
    expect(map!.failureGroups).toEqual([{ projectId: P, failures: [map!.failures[0]!], producedSince: 1 }]);
    expect(costOf([learn!, title!, map!])).toEqual({ costUsd: 1.75 + 0 + 2.1, tokens: 70_000 + 4_000 + 1_600_000, runs: 4 + 2 + 2, runsWithoutCost: 3 });
    // The headline is the outcome, never the status: a failed run that kept spores still learned them.
    expect(outcomeHeadline('learn', learn!)).toBe('Learned 9 spores from 6 sessions');
    expect(outcomeHeadline('map', { ...map!, maps: 0, produced: 0, finished: 2, failed: 2 })).toBe('Couldn’t update the code map');
    expect(outcomeHeadline('title', title!)).toBe('Titled and summarized 2 sessions');
  });

  it('words skips, starters and spend for a person', () => {
    expect([skipWords('max_runs_per_day'), skipWords('capability_off'), skipWords('input_unchanged'), skipWords('no session is waiting for a title'), skipWords('some_new_code'), skipWords(null)]).toEqual([
      'today’s run limit was reached', 'it was switched off for this project', 'nothing new since the last run', 'Myco didn’t need to run it', 'Myco didn’t need to run it', 'Myco didn’t need to run it',
    ]);
    const names = (id: string) => (id === ADMIN.member.id ? 'Ada' : null);
    expect([startedByWords('clock', names), startedByWords('backfill', names), startedByWords(ADMIN.member.id, names), startedByWords('mem_unknown0001', names), startedByWords(null, names)])
      .toEqual(['On its schedule', 'To title imported sessions', 'By Ada', 'By a member', null]);
    expect(spendWords({ tokens: [500_000, 2_000_000], costUsd: [1, 2.3], durationMs: [4 * MINUTE, 10 * MINUTE] }, 'updates', 'This week')).toEqual({
      spend: 'This week’s updates each used 500K to 2 million tokens, about $1.00 to $2.30 by the agent’s estimate.',
      took: 'Recent ones took 4 to 10 minutes.',
    });
    expect(spendWords({ tokens: null, costUsd: null, durationMs: null }, 'updates', 'This week')).toEqual({ spend: null, took: null });
    expect([workBounds('week', NOW), workBounds('today', NOW)]).toEqual([WEEK, TODAY]);
  });
});

describe('Myco’s work', () => {
  it('tells the week as outcomes, each with its evidence, its latest runs and any failure beside it', async () => {
    const asked = server(week());
    mount(`/p/${P}/work`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toBe('Myco’s work');
    await waitFor(() => expect(document.querySelector('[data-lede]')).not.toBeNull());
    expect(document.querySelector('[data-lede]')!.textContent).toBe(
      'This week in Myco, it learned 6 spores from 4 sessions, titled 2 sessions and updated the code map once. 1 code map update failed, and none has worked since.',
    );
    const work = asked.find((url) => url.pathname === '/api/work')!;
    expect([work.searchParams.get('project'), Number(work.searchParams.get('since')), Number(work.searchParams.get('until'))]).toEqual([P, WEEK.since, WEEK.until]);
    expect([...document.querySelectorAll('article[data-outcome]')].map((a) => a.getAttribute('data-outcome'))).toEqual(['learn', 'title', 'map']);

    // Learning: the spores it wrote, never a spore an agent saved in a session; the runs, one held off.
    const learn = card('learn');
    expect(within(learn).getByRole('heading', { level: 2 }).textContent).toBe('Learned 6 spores from 4 sessions');
    expect(learn.textContent).toContain('3 learning runs · the latest today at 14:00 · held off once');
    await waitFor(() => expect(within(learn).getByRole('list', { name: 'Spores it wrote' }).querySelectorAll('li')).toHaveLength(3));
    expect(learn.textContent).not.toContain('never Myco’s');
    expect(learn.querySelector('[data-spore-types]')!.textContent).toBe('2 gotchas2 decisions1 fix1 pattern');
    const runs = await within(learn).findByRole('list', { name: 'Latest learning runs' });
    const lines = [...runs.querySelectorAll('li')];
    expect(lines.map((li) => li.getAttribute('data-run-line'))).toEqual(['held', 'plain', 'plain']);
    expect(lines[0]!.textContent).toContain('Held off: it was switched off for this project');
    expect(lines[1]!.textContent).toContain('2 spores from 3 sessions, then stopped');
    expect(lines[2]!.textContent).toContain('4 spores from 1 session');
    expect(lines[2]!.textContent).toContain('Ada’s studio Mac · by Lin');
    expect(within(lines[2]!).getByRole('link').getAttribute('href')).toBe(`/p/${P}/work/runs/run_a2c4e6f801`);
    // The run that stopped early but kept its spores is a quiet note: nothing to do.
    expect(learn.querySelector('[data-kept]')!.textContent).toBe('One run stopped early: saved 2 spores from 3 sessions before the turn budget ran out. It kept the 2 spores it had saved, so there’s nothing to do.');
    expect(learn.querySelector('[data-failure]')).toBeNull();

    // Titles: the sessions by their titles.
    const title = card('title');
    expect(within(title).getByRole('heading', { level: 2 }).textContent).toBe('Titled and summarized 2 sessions');
    const titled = await within(title).findByRole('list', { name: 'Sessions it titled' });
    await waitFor(() => expect(within(titled).getAllByRole('link').map((a) => a.textContent)).toEqual(['Search box height made uniform on list pages', 'Flaky test port collision fixed']));

    // The map: where it stands, and the failure beside it, on the machine it ran on, with what to do.
    const map = card('map');
    expect(map.textContent).toContain('Now at main @ 8194811, yesterday at 20:00');
    const failure = map.querySelector('[data-failure="open"]') as HTMLElement;
    expect(failure.closest('article')).toBe(map);
    // Lin's machine is named to Lin alone: Ada reads it as Lin's.
    await waitFor(() => expect(failure.textContent).toContain('On Lin’s machine: repo.sha256 is absent from this checkout, so the previous map is kept.'));
    expect(failure.textContent).toContain('1 code map update failed this week');
    // The next step never repeats what the cause already says.
    expect(failure.textContent).toContain('the previous map is kept.Open the run to see where it stopped.');
    expect(failure.textContent!.match(/previous map/g)).toHaveLength(1);
    expect(within(failure).getByRole('link', { name: 'Open the latest attempt →' }).getAttribute('href')).toBe(`/p/${P}/work/runs/run_5e0b1c2d3f`);
    expect(within(map).getByRole('list', { name: 'Latest code map updates' }).textContent).toContain('by you');

    // Upkeep is one quiet line, and the cost is labelled as the agents' own estimate.
    const rail = screen.getByRole('complementary', { name: 'Upkeep and cost' });
    expect(rail.querySelector('[data-upkeep]')!.textContent).toContain('Search kept up to date · 1 h ago · 1 retry along the way');
    expect(within(rail).getByRole('link', { name: 'Health →' })).toBeTruthy();
    const cost = rail.querySelector('[data-cost]') as HTMLElement;
    expect(cost.querySelector('[data-cost-total]')!.textContent).toBe('$3.60');
    expect(cost.textContent).toContain('1.7 million tokens over 7 runs.');
    expect(cost.textContent).toContain('These are the agents’ own estimates, not a bill. 2 runs reported no cost, so the real total is higher.');
    expect(document.querySelectorAll('[data-filter-bar]')).toHaveLength(1);
    expect(rawIdsInPage()).toEqual([]);
  });

  it('gives a member everything an admin sees, cost and "Run a task" included, but no link to Health', async () => {
    const asked = server(week({ who: MEMBER }));
    mount(`/p/${P}/work`);
    await waitFor(() => expect(card('learn')).not.toBeNull());
    expect(screen.getByRole('button', { name: 'Run a task' })).toBeTruthy();
    expect(document.querySelector('[data-cost-total]')!.textContent).toBe('$3.60');
    const learn = card('learn');
    await waitFor(() => expect(within(learn).getByRole('list', { name: 'Latest learning runs' }).textContent).toContain('by you'));
    expect(screen.getByRole('complementary', { name: 'Upkeep and cost' }).textContent).not.toContain('Health');
    expect(screen.queryByRole('link', { name: /Change what Myco does/ })).toBeNull();
    expect(asked.some((url) => url.pathname === `/api/projects/${P}/capabilities`)).toBe(true);
    expect(rawIdsInPage()).toEqual([]);
  });

  it('names a machine only to the member it belongs to, and to anyone else as that member’s; never by its id', async () => {
    const lineOf = async (text: string) => {
      const runs = await waitFor(() => within(card('learn')).getByRole('list', { name: 'Latest learning runs' }));
      return waitFor(() => { const li = [...runs.querySelectorAll('li')].find((l) => l.textContent!.includes(text)); if (li === undefined) throw new Error('not yet'); return li; });
    };
    const page = () => document.querySelector('main')!.textContent!;
    // Lin reads Ada's studio Mac as Ada's, and her own build box by its name.
    server(week({ who: MEMBER }));
    mount(`/p/${P}/work`);
    expect((await lineOf('4 spores from 1 session')).textContent).toContain('from Ada · by you');
    await waitFor(() => expect(card('map').querySelector('[data-failure]')!.textContent).toContain('On Lin’s build box: repo.sha256'));
    expect(page()).not.toContain('Ada’s studio Mac');
    for (const id of [STUDIO_ID, BUILDBOX_ID]) expect(page()).not.toContain(id);
    expect(page()).not.toMatch(/\b[Aa] machine\b/);
    expect(rawIdsInPage()).toEqual([]);
    cleanup();
    client.clear();
    // Ada reads her own by its name, and Lin's as Lin's.
    server(week());
    mount(`/p/${P}/work`);
    expect((await lineOf('4 spores from 1 session')).textContent).toContain('Ada’s studio Mac · by Lin');
    await waitFor(() => expect(card('map').querySelector('[data-failure]')!.textContent).toContain('On Lin’s machine: repo.sha256'));
    expect(within(card('map')).getByRole('list', { name: 'Latest code map updates' }).textContent).toContain('from Lin');
    expect(page()).not.toContain('Lin’s build box');
    for (const id of [STUDIO_ID, BUILDBOX_ID]) expect(page()).not.toContain(id);
    expect(rawIdsInPage()).toEqual([]);
  });

  it('keeps a map failure in one project open when the map worked in another', async () => {
    const answer: WorkAnswer = {
      ...WEEK_WORK,
      outcomes: [...WEEK_WORK.outcomes, outcome({ projectId: P2, kind: 'map', task: 'canopy-map', runs: { completed: 1 }, outcome: { spores: 0, sessions: 0, maps: 1 } })],
      runs: [...WEEK_WORK.runs, workRun({ id: 'run_atlasmap01', projectId: P2, kind: 'map', task: 'canopy-map', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 1 } })],
    };
    const [, , map] = summarize(answer);
    expect(map!.failureGroups.map((group) => [group.projectId, group.failures.length, group.producedSince])).toEqual([[P, 1, 0]]);
    server(week({ work: answer }));
    mount('/work');
    await waitFor(() => expect(card('map')).not.toBeNull());
    const failure = card('map').querySelector('[data-failure]') as HTMLElement;
    expect(failure.getAttribute('data-failure')).toBe('open');
    expect(failure.textContent).toContain('1 code map update failed this week in Myco');
    expect(document.querySelector('[data-lede]')!.textContent).toContain('1 code map update failed, and none has worked since.');
  });

  it('shows every run of a task on "Show all", a page at a time, and links each project’s from the page across projects', async () => {
    const many = Array.from({ length: 6 }, (_, i) => runRow({ id: `run_many0000${i}`, task: 'extract-curate', completedAt: NOW - (i + 1) * HOUR, outcome: { spores: 1, sessions: 1, readsRecorded: true } }));
    const older = runRow({ id: 'run_older00001', task: 'extract-curate', completedAt: NOW - 30 * HOUR, outcome: { spores: 2, sessions: 2, readsRecorded: true } });
    const asked = server({
      ...week({ taskRuns: { 'extract-curate': many, 'title-summary': [], 'canopy-map': [], 'vault-seed': [] } }),
      [`/api/projects/${P}/runs`]: (url) => {
        if (url.searchParams.get('limit') === '6') return Response.json({ rows: url.searchParams.get('task') === 'extract-curate' ? many : [], cursor: null });
        return url.searchParams.get('cursor') === 'c1' ? Response.json({ rows: [older], cursor: null }) : Response.json({ rows: many, cursor: 'c1' });
      },
    });
    mount(`/p/${P}/work`);
    const runs = await within(await findCard('learn')).findByRole('list', { name: 'Latest learning runs' });
    await waitFor(() => expect(runs.querySelectorAll('li')).toHaveLength(5));
    fireEvent.click(within(card('learn')).getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(within(card('learn')).getByRole('list', { name: 'Latest learning runs' }).querySelectorAll('li')).toHaveLength(6));
    fireEvent.click(within(card('learn')).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(card('learn')).getByRole('list', { name: 'Latest learning runs' }).querySelectorAll('li')).toHaveLength(7));
    const pages = asked.filter((url) => url.pathname === `/api/projects/${P}/runs` && url.searchParams.get('limit') === '20');
    expect(pages.map((url) => [url.searchParams.get('task'), url.searchParams.get('cursor')])).toEqual([['extract-curate', null], ['extract-curate', 'c1']]);
    cleanup();
    client.clear();
    server(week());
    mount('/work');
    const links = await waitFor(() => { const found = card('learn')?.querySelector('[data-all-runs]'); if (found == null) throw new Error('not yet'); return found as HTMLElement; });
    expect(within(links).getByRole('link', { name: 'All runs in Myco →' }).getAttribute('href')).toBe(`/p/${P}/work?outcome=learn&runs=all`);
  });

  it('links a learning card and a titles card to the window’s sessions', async () => {
    server(week());
    mount(`/p/${P}/work`);
    expect((await within(await findCard('learn')).findByRole('link', { name: 'This week’s sessions →' })).getAttribute('href')).toBe(`/p/${P}/sessions?window=week`);
    expect((await within(card('title')).findByRole('link', { name: 'See this week’s sessions →' })).getAttribute('href')).toBe(`/p/${P}/sessions?window=week`);
  });

  it('searches the coded headline and its disclosed reason', async () => {
    const reason = 'The requested tool was unavailable.';
    const failed = workRun({ id: 'run_search', projectId: P, kind: 'map', task: 'canopy-map', result: 'failed', at: NOW - HOUR,
      failure: { source: 'report', code: 'machine_did_not_start', cause: 'The machine recorded a missing tool.', error: reason } });
    server(week({ work: { ...WEEK_WORK, runs: [...WEEK_WORK.runs.filter((run) => run.kind !== 'map'), failed] } }));
    mount(`/p/${P}/work`);
    await findCard('map');
    const search = screen.getByRole('searchbox', { name: 'Search what Myco did' });
    for (const query of ['No machine started', 'requested tool', 'recorded a missing tool']) {
      fireEvent.change(search, { target: { value: query } });
      await waitFor(() => expect(card('map').querySelector('[data-failure]')?.textContent).toContain('No machine started the task within a day.'));
    }
    expect(card('map').textContent).not.toContain(reason);
    fireEvent.click(within(card('map')).getByRole('button', { name: 'Details' }));
    expect(card('map').textContent).toContain(reason);
    expect(card('map').textContent).toContain('The machine recorded a missing tool.');
  });

  it('keeps the window, the outcome and the search in the URL, and reads the window it names', async () => {
    server(week());
    mount(`/p/${P}/work`);
    await waitFor(() => expect(card('map')).not.toBeNull());
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search what Myco did' }), { target: { value: 'sha256' } });
    await waitFor(() => expect(location()).toBe(`/p/${P}/work?q=sha256`));
    // The failure that matches stays; a card with nothing matching says so.
    expect(card('map').querySelector('[data-failure]')).not.toBeNull();
    await waitFor(() => expect(card('learn').textContent).toContain('Nothing here matches your search.'));
    cleanup();
    client.clear();
    const later = server(week());
    mount(`/p/${P}/work?outcome=map&window=today`);
    await waitFor(() => expect(card('map')).not.toBeNull());
    expect(card('learn')).toBeNull();
    // The page reads the window it names; the week is read beside it for the spend a task's confirmation states.
    const windows = later.filter((url) => url.pathname === '/api/work').map((url) => [Number(url.searchParams.get('since')), Number(url.searchParams.get('until'))]);
    expect(windows).toContainEqual([TODAY.since, TODAY.until]);
    expect(windows).toContainEqual([WEEK.since, WEEK.until]);
    expect(screen.getByRole('combobox', { name: 'When' }).textContent).toBe('Today');
    expect(screen.getByRole('combobox', { name: 'Outcome' }).textContent).toBe('Code map');
  });

  it('reads again every 30 s only while a run is queued or running, never from a hidden tab', async () => {
    const live: WorkAnswer = { ...WEEK_WORK, outcomes: WEEK_WORK.outcomes.map((o) => (o.kind === 'learn' ? { ...o, runs: { ...o.runs, queued: 1 } } : o)) };
    type Polled = { refetchInterval?: number | false | ((q: unknown) => number | false); refetchIntervalInBackground?: boolean };
    const intervals = (key: string) => client.getQueryCache().findAll({ queryKey: key === 'runs' ? ['runs', P, 'task'] : [key] }).flatMap((query) => query.observers.map((observer) => {
      const { refetchInterval, refetchIntervalInBackground } = observer.options as Polled;
      return { interval: typeof refetchInterval === 'function' ? refetchInterval(query) : refetchInterval ?? false, background: refetchIntervalInBackground };
    }));
    server(week({ work: live }));
    mount(`/p/${P}/work`);
    await waitFor(() => expect(card('learn')).not.toBeNull());
    await waitFor(() => expect(within(card('learn')).getByRole('list', { name: 'Latest learning runs' })).toBeTruthy());
    for (const key of ['work', 'runs']) {
      const options = intervals(key);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) expect({ key, ...option }).toEqual({ key, interval: LIVE_REFRESH_MS, background: false });
    }
    cleanup();
    client.clear();
    server(week());
    mount(`/p/${P}/work`);
    await waitFor(() => expect(card('learn')).not.toBeNull());
    await waitFor(() => expect(within(card('learn')).getByRole('list', { name: 'Latest learning runs' })).toBeTruthy());
    for (const key of ['work', 'runs']) for (const option of intervals(key)) expect({ key, interval: option.interval }).toEqual({ key, interval: false });
  });

  it('spans every project at /work: each run names its project, no project’s run list is read, and a task is started from a project', async () => {
    const asked = server(week({
      work: { ...WEEK_WORK, outcomes: [...WEEK_WORK.outcomes, outcome({ projectId: P2, kind: 'learn', task: 'extract-curate', outcome: { spores: 1, sessions: 1, maps: 0 } })] },
    }));
    mount('/work');
    await waitFor(() => expect(card('learn')).not.toBeNull());
    expect(screen.getByText('What Myco did in the background, across every project, grouped by what came of it.')).toBeTruthy();
    expect(asked.find((url) => url.pathname === '/api/work')!.searchParams.get('project')).toBeNull();
    expect(document.querySelector('[data-lede]')!.textContent).toContain('This week, Myco learned 7 spores from 5 sessions');
    expect(document.querySelector('[data-lede]')!.textContent).toContain('across 2 projects');
    expect(card('learn').textContent).toContain('in 2 projects');
    const runs = within(card('learn')).getByRole('list', { name: 'Latest learning runs' });
    expect(runs.textContent).toContain('Myco');
    expect(asked.some((url) => url.pathname.endsWith('/runs'))).toBe(false);
    expect(screen.queryByRole('button', { name: 'Run a task' })).toBeNull();
    expect(document.querySelector('[data-when]')!.textContent).toContain('To start a task by hand, pick a project in the nav.');
    expect(within(screen.getByRole('navigation', { name: 'Pages' })).getByRole('link', { name: 'Myco’s work' }).getAttribute('aria-current')).toBe('page');
    expect(rawIdsInPage()).toEqual([]);
  });

  it('says a quiet window in one line, and offers the week from a quiet day', async () => {
    const quiet: WorkAnswer = { ...WEEK_WORK, outcomes: [], runs: [] };
    server(week({ work: quiet }));
    mount(`/p/${P}/work?window=today`);
    expect(await screen.findByText('Nothing ran today')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show this week' }));
    await waitFor(() => expect(location()).toBe(`/p/${P}/work`));
  });

  it('says why it could not read the work, with a way to try again', async () => {
    server({ ...week(), '/api/work': () => new Response(null, { status: 500 }) });
    mount(`/p/${P}/work`);
    expect(await screen.findByText('The server had a problem')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('leads the Agent runs addresses to Myco’s work, the run and the query kept', async () => {
    server(week());
    mount(`/p/${P}/runs?status=failed`);
    await waitFor(() => expect(location()).toBe(`/p/${P}/work?status=failed`));
    cleanup();
    client.clear();
    server(week());
    mount(`/p/${P}/runs/run_a2c4e6f801`);
    await waitFor(() => expect(location()).toBe(`/p/${P}/work/runs/run_a2c4e6f801`));
  });
});
