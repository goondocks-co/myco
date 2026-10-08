import { dashboardMe } from '../helpers/dashboard-permissions';
import { TASK_DESCRIPTIONS } from './task-fixture';
/**
 * Myco's work: what Myco's own runs came to, grouped by outcome, each failure
 * beside the outcome it belongs to, search upkeep as one line, the cost rail,
 * the filters in the URL, polling only while a run is still to finish, the
 * page across every project, and the Agent runs addresses leading here.
 *
 * The clock is held at a fixed afternoon so every instant sits on the day it names.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  '/auth/me': () => Response.json(dashboardMe(over.who ?? ADMIN)),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/members': () => Response.json(MEMBERS),
  '/api/tasks': () => Response.json({ tasks: TASK_DESCRIPTIONS }),
  '/api/tasks/names': () => Response.json({ tasks: TASK_DESCRIPTIONS.map(({ task, name }) => ({ task, name })) }),
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
  it('names queued, running, skipped, completed, produced and failed states for every outcome', () => {
    const states = {
      learn: ['Waiting to learn from recent sessions', 'Learning from recent sessions now', 'Learning was held off', 'Read new sessions and found nothing new to keep', 'Learned 1 spore', 'Couldn’t learn from recent sessions'],
      title: ['Waiting to title sessions', 'Titling sessions now', 'Titling was held off', 'Checked for sessions to title; none needed one', 'Titled and summarized 1 session', 'Couldn’t title sessions'],
      map: ['Waiting to update the code map', 'Updating the code map now', 'The code map update was held off', 'Checked the code map; nothing to change', 'Updated the code map once', 'Couldn’t update the code map'],
      seed: ['Waiting to learn from the project’s code', 'Learning from the project’s code now', 'Learning from the code was held off', 'Read the project’s code and found nothing new to keep', 'Learned 1 spore from the project’s code', 'Couldn’t learn from the project’s code'],
    } as const;
    for (const kind of ['learn', 'title', 'map', 'seed'] as const) {
      const base = { spores: 0, sessions: 0, maps: 0, produced: 0, failed: 0, finished: 0 };
      const output = kind === 'learn' || kind === 'seed' ? { spores: 1 } : kind === 'title' ? { sessions: 1 } : { maps: 1 };
      expect([
        outcomeHeadline(kind, { ...base, runs: { queued: 1 } }),
        outcomeHeadline(kind, { ...base, runs: { running: 1 } }),
        outcomeHeadline(kind, { ...base, runs: { skipped: 1 } }),
        outcomeHeadline(kind, { ...base, runs: { completed: 1 }, finished: 1 }),
        outcomeHeadline(kind, { ...base, ...output, runs: { completed: 1 }, finished: 1, produced: 1 }),
        outcomeHeadline(kind, { ...base, runs: { failed: 1 }, finished: 1, failed: 1 }),
      ]).toEqual(states[kind]);
    }
  });

  it('sums each kind of work across projects: outcomes, failures, recoveries, spend and cost', () => {
    const answer: WorkAnswer = {
      ...WEEK_WORK,
      outcomes: [
        ...WEEK_WORK.outcomes.map((entry) => entry.kind === 'map'
          ? { ...entry, failure: { ...entry.failure!, producedSince: 1 } }
          : entry),
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
    expect(map!.failureGroups).toMatchObject([{ projectId: P, count: 1, failures: [map!.failures[0]!], producedSince: 1 }]);
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
  it('keeps a queued code-learning card in waiting language', async () => {
    server(week({ work: {
      ...WEEK_WORK,
      outcomes: [outcome({ kind: 'seed', task: 'vault-seed', runs: { queued: 1 }, latestAt: NOW - HOUR })],
      runs: [],
    } }));
    mount(`/p/${P}/work`);
    const seed = await findCard('seed');
    expect(within(seed).getByRole('heading', { level: 2 }).textContent).toBe('Waiting to learn from the project’s code');
    expect(seed.textContent).not.toContain('Read the project’s code');
  });

  for (const { kind, task, output, noun, saved } of [
    { kind: 'learn', task: 'extract-curate', output: { spores: 1, sessions: 1, maps: 0 }, noun: 'learning run', saved: 'spores saved from recent sessions' },
    { kind: 'seed', task: 'vault-seed', output: { spores: 1, sessions: 0, maps: 0 }, noun: 'run over the code', saved: 'spores saved from the project’s code' },
    { kind: 'title', task: 'title-summary', output: { spores: 0, sessions: 1, maps: 0 }, noun: 'titling run', saved: 'session titles and summaries written' },
    { kind: 'map', task: 'canopy-map', output: { spores: 0, sessions: 0, maps: 1 }, noun: 'code map update', saved: 'code map updates written' },
  ] as const) {
    it(`keeps the full-window saved-output failure visible for ${kind} beyond the 200-run page`, async () => {
      const runs = Array.from({ length: 200 }, (_, i) => workRun({
        id: `run_${kind}_${i}`, kind, task, at: NOW - i * MINUTE, outcome: output,
      }));
      const cursor = JSON.stringify([runs[199]!.at, P, runs[199]!.id]);
      const older = workRun({
        id: `run_${kind}_older`, kind, task, status: 'failed', result: 'failed_with_output',
        at: NOW - 201 * MINUTE, outcome: output,
        failure: { cause: 'Stopped after saving output', source: 'error' },
      });
      const first: WorkAnswer = {
        ...WEEK_WORK,
        outcomes: [outcome({
          kind, task, runs: { completed: 200, failed: 1 }, failedWithOutput: 1,
          outcome: { spores: 201 * output.spores, sessions: 201 * output.sessions, maps: 201 * output.maps },
        })],
        runs, truncated: true, cursor,
      };
      server({
        ...week({ work: first }),
        '/api/work': (url) => Response.json(url.searchParams.get('cursor') === cursor
          ? { ...first, runs: [older], truncated: false, cursor: null }
          : first),
      });
      mount('/work');
      const panel = await findCard(kind);
      await waitFor(() => expect(panel.querySelector('[data-kept]')).not.toBeNull());
      expect(panel.querySelector('[data-kept]')!.textContent).toBe(`One ${noun} stopped early. The ${saved} are kept.`);
      fireEvent.click(within(document.querySelector('[data-work-evidence]') as HTMLElement).getByRole('button', { name: 'Show more' }));
      await waitFor(() => expect(panel.querySelectorAll('[data-run-line]')).toHaveLength(201));
      expect(panel.querySelector('[data-kept]')!.textContent).toContain(`One ${noun} stopped early`);
      expect(panel.querySelector('[data-kept]')!.textContent).toContain(`The ${saved} are kept.`);
    });
  }

  it('surfaces a failed per-task run read with a retry', async () => {
    server({
      ...week(),
      [`/api/projects/${P}/runs`]: (url) => url.searchParams.get('task') === 'canopy-map'
        ? new Response('unavailable', { status: 503 })
        : Response.json({ rows: TASK_RUNS[url.searchParams.get('task') ?? ''] ?? [], cursor: null }),
    });
    mount(`/p/${P}/work`);
    const map = await findCard('map');
    await waitFor(() => expect(map.textContent).toContain('Couldn’t read code map updates.'));
    expect(within(map).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

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
    expect(lines[1]!.textContent).toContain('Failed with output kept');
    expect(lines[2]!.textContent).toContain('4 spores from 1 session');
    expect(lines[2]!.textContent).toContain('Ada’s studio Mac · by Lin');
    expect(within(lines[2]!).getByRole('link').getAttribute('href')).toBe(`/p/${P}/work/runs/run_a2c4e6f801`);
    // The run that stopped early but kept its spores is a quiet note: nothing to do.
    expect(learn.querySelector('[data-kept]')!.textContent).toBe('One learning run stopped early: saved 2 spores from 3 sessions before the turn budget ran out. The spores saved from recent sessions are kept.');
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

    // Upkeep is one line; the cost rail discloses estimates and missing costs.
    const rail = screen.getByRole('complementary', { name: 'Upkeep and cost' });
    expect(rail.querySelector('[data-upkeep]')!.textContent).toContain('Search kept up to date · 1 h ago · 1 retry along the way');
    expect(within(rail).getByRole('link', { name: 'Health →' })).toBeTruthy();
    const cost = rail.querySelector('[data-cost]') as HTMLElement;
    expect(cost.querySelector('[data-cost-total]')!.textContent).toBe('$3.60');
    expect(cost.textContent).toContain('1.7 million tokens over 7 runs.');
    expect(cost.textContent).toContain('Recorded costs may include agent estimates and estimates using model prices; they are not a bill. 2 runs reported no cost, so the total is incomplete.');
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

  it('describes mixed recovery across Projects without claiming none worked', async () => {
    const second = outcome({
      projectId: P2, kind: 'map', task: 'canopy-map',
      runs: { completed: 1, failed: 1 }, failed: 1,
      outcome: { spores: 0, sessions: 0, maps: 1 },
      failure: { runs: 1, since: NOW - 4 * HOUR, latestAt: NOW - 4 * HOUR, latestRunId: 'run_atlasfailed', producedSince: 1 },
    });
    server(week({ work: { ...WEEK_WORK, outcomes: [...WEEK_WORK.outcomes, second] } }));
    mount('/work');
    await waitFor(() => expect(document.querySelector('[data-lede]')).not.toBeNull());
    expect(document.querySelector('[data-lede]')!.textContent).toContain('2 code map updates failed; some projects have worked since, while others are still waiting for a successful run.');
  });

  it('shows an older Project failure beyond the work evidence page and retrieves it', async () => {
    const cursor = JSON.stringify([NOW - HOUR, P2, 'run_atlasmap01']);
    const latest = workRun({ id: 'run_atlasmap01', projectId: P2, kind: 'map', task: 'canopy-map', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 1 } });
    const first: WorkAnswer = {
      ...WEEK_WORK,
      outcomes: [...WEEK_WORK.outcomes, outcome({ projectId: P2, kind: 'map', task: 'canopy-map', runs: { completed: 1 }, outcome: { spores: 0, sessions: 0, maps: 1 } })],
      runs: [latest],
      truncated: true,
      cursor,
    };
    let current = first;
    const asked = server({
      ...week({ work: first }),
      '/api/work': (url) => Response.json(url.searchParams.get('cursor') === cursor
        ? { ...first, runs: [WEEK_WORK.runs.find((run) => run.id === 'run_5e0b1c2d3f')], truncated: false, cursor: null }
        : current),
    });
    mount('/work');
    const map = await findCard('map');
    await waitFor(() => expect(map.querySelector('[data-failure]')).not.toBeNull());
    expect(map.querySelector('[data-failure]')!.textContent).toContain('1 code map update failed this week in Myco');
    expect(map.querySelector('[data-failure]')!.textContent).toContain('Showing 0 of 1 failed runs here');
    expect(document.querySelector('[data-lede]')!.textContent).toContain('none has worked since');
    fireEvent.click(within(document.querySelector('[data-work-evidence]') as HTMLElement).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(map).getByRole('list', { name: 'Latest code map updates' }).textContent).toContain('Failed'));
    expect(asked.filter((url) => url.pathname === '/api/work').map((url) => url.searchParams.get('cursor'))).toContain(cursor);
    const updated = { ...latest, status: 'failed', result: 'failed' as const, outcome: { spores: 0, sessions: 0, maps: 0 }, failure: { cause: 'The new attempt failed', source: 'error' as const } };
    current = {
      ...first,
      outcomes: first.outcomes.map((entry) => entry.projectId === P2 && entry.kind === 'map'
        ? { ...entry, runs: { failed: 1 }, failed: 1, outcome: { spores: 0, sessions: 0, maps: 0 },
          failure: { runs: 1, since: latest.at!, latestAt: latest.at!, latestRunId: latest.id, producedSince: 0 } }
        : entry),
      runs: [updated],
    };
    await act(async () => { await client.invalidateQueries({ queryKey: ['work', 'all', WEEK.since, WEEK.until] }); });
    await waitFor(() => expect(within(map).getByRole('list', { name: 'Latest code map updates' }).querySelectorAll('[data-run-line="bad"]')).toHaveLength(2));
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
    fireEvent.click(within(card('learn')).getByRole('button', { name: 'Show all · all time' }));
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
    expect(within(links).getByRole('link', { name: 'All runs in Myco · all time →' }).getAttribute('href')).toBe(`/p/${P}/work?outcome=learn&runs=all`);
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

  it('spans every project at /work: each run names its project, no project’s run list is read, and Run a task is offered here too', async () => {
    const asked = server(week({
      work: { ...WEEK_WORK, outcomes: [...WEEK_WORK.outcomes, outcome({ projectId: P2, kind: 'learn', task: 'extract-curate', outcome: { spores: 1, sessions: 1, maps: 0 } })] },
    }));
    mount('/work');
    await waitFor(() => expect(card('learn')).not.toBeNull());
    expect(screen.getByText('What Myco did in the background, grouped by what came of it.')).toBeTruthy();
    expect(asked.find((url) => url.pathname === '/api/work')!.searchParams.get('project')).toBeNull();
    expect(document.querySelector('[data-lede]')!.textContent).toContain('This week, Myco learned 7 spores from 5 sessions');
    expect(document.querySelector('[data-lede]')!.textContent).toContain('across 2 projects');
    expect(card('learn').textContent).toContain('in 2 projects');
    const runs = within(card('learn')).getByRole('list', { name: 'Latest learning runs' });
    expect(runs.textContent).toContain('Myco');
    expect(asked.some((url) => url.pathname.endsWith('/runs'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Run a task' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Showing: All projects' })).toBeTruthy();
    expect(document.querySelector('[data-when]')!.textContent).not.toContain('pick a project');
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

it('keeps yesterday out of Today’s runs and requests the selected bounds', async () => {
  const asked = server({ ...week(), [`/api/projects/${P}/runs`]: (url) => {
    const since = Number(url.searchParams.get('since'));
    const until = Number(url.searchParams.get('until'));
    const rows = [runRow({ id: 'today-map', task: 'canopy-map', completedAt: NOW }), runRow({ id: 'yesterday-map', task: 'canopy-map', completedAt: NOW - 30 * HOUR })];
    return Response.json({ rows: rows.filter((row) => row.completedAt! >= since && row.completedAt! < until), cursor: null });
  } });
  mount(`/p/${P}/work?window=today&outcome=map`);
  const runs = await screen.findByRole('list', { name: 'Latest code map updates' });
  expect(within(runs).getAllByRole('link')).toHaveLength(1);
  expect(within(runs).getByRole('link').getAttribute('href')).toContain('today-map');
  expect(asked.filter((url) => url.pathname.endsWith('/runs')).every((url) => Number(url.searchParams.get('since')) === TODAY.since && Number(url.searchParams.get('until')) === TODAY.until)).toBe(true);
  expect(await screen.findByRole('button', { name: 'Show all · all time' })).toBeTruthy();
});

for (const across of [false, true]) {
  it(`renders requested and actual models with a mismatch in the ${across ? 'all projects' : 'project'} run list`, async () => {
    const evidence = {
      requested: { tier: 'high' as const, model: 'opus', effort: 'high', sources: { tier: 'task' as const, model: 'default' as const } },
      harness: 'claude-code',
      identity: { status: 'reported' as const, source: 'result', primary: { model: 'claude-sonnet-4-6' }, models: [{ model: 'claude-sonnet-4-6', source: 'result', usage: null }] },
    };
    const answer = { ...WEEK_WORK, runs: WEEK_WORK.runs.map((run) => run.kind === 'map' ? { ...run, ...evidence } : run) };
    server(week({ work: answer, taskRuns: { ...TASK_RUNS, 'canopy-map': TASK_RUNS['canopy-map']!.map((run) => ({ ...run, ...evidence })) } }));
    mount(across ? '/work?outcome=map' : `/p/${P}/work?outcome=map`);
    const runs = await screen.findByRole('list', { name: 'Latest code map updates' });
    expect(runs.textContent).toContain('Asked for Opus, high effort · ran claude-sonnet-4-6');
    expect(runs.textContent).toContain('Ran a different model than requested');
  });
}

it('opens all-time history on a quiet day and requests no window bounds', async () => {
  const asked = server(week({ work: { ...WEEK_WORK, outcomes: [], runs: [] } }));
  mount(`/p/${P}/work?window=today&outcome=map&runs=all`);
  const history = await screen.findByRole('list', { name: 'All-time code map updates' });
  expect(within(history).getAllByRole('link')).toHaveLength(2);
  const query = asked.find((url) => url.pathname.endsWith('/runs'))!;
  expect(query.searchParams.get('task')).toBe('canopy-map');
  expect(query.searchParams.has('since') || query.searchParams.has('until')).toBe(false);
});

it('offers clearly labelled all-time history from an empty selected window', async () => {
  server(week({ work: { ...WEEK_WORK, outcomes: [], runs: [] } }));
  mount(`/p/${P}/work?window=today&outcome=map`);
  fireEvent.click(await screen.findByRole('button', { name: 'Show all · all time' }));
  const history = await screen.findByRole('list', { name: 'All-time code map updates' });
  expect(within(history).getAllByRole('link')).toHaveLength(2);
});
