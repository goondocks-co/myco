/**
 * Today: the day's sessions and Myco's work on one timeline, "Needs you" for an
 * admin, and capture.
 *
 * The clock is held at a fixed afternoon so every instant below sits on the
 * day it names, whatever the machine's own time.
 */
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { forgetProject } from '../../packages/myco-server/ui/src/lib/project-memory';
import { LIVE_REFRESH_MS } from '../../packages/myco-server/ui/src/hooks/use-work';
import { dayParam, dayWindow } from '../../packages/myco-server/ui/src/hooks/use-today';
import { buildTimeline, ledeCounts } from '../../packages/myco-server/ui/src/features/today/timeline';
import { attentionWords, machineNames } from '../../packages/myco-server/ui/src/features/today/words';
import { cleanSessionText, sessionHeading } from '../../packages/myco-server/ui/src/lib/session-text';
import { memberDisplayName, memberLabel } from '../../packages/myco-server/ui/src/lib/member-name';
import type {
  AttentionAnswer, AttentionItem, CaptureRow, TodaySession, TodaySpore, WorkAnswer, WorkRun,
} from '../../packages/myco-server/ui/src/features/today/wire';
import { RAW_ID } from '../helpers/raw-ids';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Tuesday, September 29 2026, 16:00 local. */
const NOW = new Date(2026, 8, 29, 16, 0, 0).getTime();
const DAY_START = new Date(2026, 8, 29).getTime();
const YESTERDAY = '2026-09-28';

/** The raw ids a reader must never see, as the screens check defines them, plus a session's UUID. */

const ADMIN = { sub: '1', login: 'ada', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '2', login: 'lin', member: { id: 'mem_Hn5pC0dJfA9sEu', label: 'Lin', role: 'member' as const } };

const P_MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const P_ATLAS = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const P_GONE = 'proj_ffffffffffffffffffffffffffffffff';
const project = (projectId: string, name: string) => ({ projectId, name, createdAt: 0, sessionCount: 3, lastActivityAt: NOW - MINUTE, archivedAt: null, archivedBy: null });
const PROJECTS = [project(P_MYCO, 'Myco'), project(P_ATLAS, 'Atlas web')];

const session = (over: Partial<TodaySession> & Pick<TodaySession, 'sessionId' | 'projectId'>): TodaySession & Record<string, unknown> => ({
  agent: 'claude-code', startedAt: NOW - HOUR, firstReceivedAt: NOW - HOUR, lastReceivedAt: NOW - 30 * MINUTE, endedAt: NOW - 30 * MINUTE,
  memberId: ADMIN.member.id, memberLabel: 'Ada', runtimeLabel: 'Ada’s studio Mac', title: null, summary: null, label: 'A session',
  promptCount: 3, toolCallCount: 0, activityBuckets: [], machineId: 'studio', createdByTokenId: 'mt_abcdefgh', branch: 'main',
  endedBy: null, endedByLabel: null, originPath: null, parentSessionId: null, parentReason: null, runtimeKind: 'cli', titledAt: null,
  ...over,
});

const SESSIONS = [
  session({ sessionId: '0b6f0f55-8a36-5d0e-9c1b-6b1d0d3f2a11', projectId: P_MYCO, label: 'Canopy parity verified', summary: 'Ran the parity suite on both targets.', startedAt: NOW - 42 * MINUTE, firstReceivedAt: NOW - 42 * MINUTE, lastReceivedAt: NOW - MINUTE, endedAt: null, promptCount: 317 }),
  session({ sessionId: '1c7a1a66-9b47-5e1f-8d2c-7c2e1e4a3b22', projectId: P_ATLAS, title: 'Checkout errors rewritten', label: 'Checkout errors rewritten', startedAt: NOW - 5 * HOUR, agent: 'cursor', runtimeLabel: null, memberLabel: 'Lin', memberId: MEMBER.member.id, promptCount: 1 }),
  session({ sessionId: '2d8b2b77-ac58-5f20-9e3d-8d3f2f5b4c33', projectId: P_MYCO, label: '2d8b2b77-ac58-5f20-9e3d-8d3f2f5b4c33', startedAt: NOW - 9 * HOUR, agent: 'pi', runtimeLabel: null, memberId: 'mem_harness', memberLabel: 'mem_harness' }),
  session({ sessionId: '3e9c3c88-bd69-5031-af4e-9e4a3a6c5d44', projectId: P_GONE, title: 'A session in a project this viewer has no name for', label: 'A session in a project this viewer has no name for', startedAt: NOW - 10 * HOUR }),
];

const run = (over: Partial<WorkRun> & Pick<WorkRun, 'id' | 'kind' | 'task'>): WorkRun => ({
  projectId: P_MYCO, status: 'completed', result: 'produced', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 0 },
  sessionId: null, failure: null, tokens: 1000, costUsd: 0.1, ...over,
});

const RUNS: WorkRun[] = [
  run({ id: 'run_4f1c9a2e7b', kind: 'learn', task: 'extract-curate', status: 'failed', result: 'failed_with_output', at: NOW - 2 * HOUR, outcome: { spores: 2, sessions: 3, maps: 0 }, failure: { cause: 'the run exceeded its turn budget', source: 'report' } }),
  run({ id: 'run_e0a4d2b917', kind: 'learn', task: 'extract-curate', at: NOW - 7 * HOUR, outcome: { spores: 5, sessions: 4, maps: 0 } }),
  run({ id: 'run_c19f7a0e55', kind: 'map', task: 'canopy-map', status: 'failed', result: 'failed', at: NOW - 8 * HOUR, failure: { cause: 'repo.sha256 is absent from the checkout', source: 'report' } }),
  run({ id: 'run_t1aaaaaaaa', kind: 'title', task: 'title-summary', at: NOW - 3 * HOUR, sessionId: '1c7a1a66-9b47-5e1f-8d2c-7c2e1e4a3b22', projectId: P_ATLAS, outcome: { spores: 0, sessions: 1, maps: 0 } }),
  run({ id: 'run_t2bbbbbbbb', kind: 'title', task: 'title-summary', at: NOW - 3 * HOUR - MINUTE, sessionId: null, projectId: P_ATLAS, outcome: { spores: 0, sessions: 1, maps: 0 } }),
];

const spore = (id: string, author: string, type: string, line: string, at: number): TodaySpore & Record<string, unknown> => ({
  projectId: P_MYCO, id, observationType: type, status: 'active', content: `${line}\n\nMore.`, agentLine: line, author, createdAt: at,
  agentId: 'myco-agent', sessionId: null, promptId: null, context: null, importance: 5, filePath: null, tags: null, contentHash: null,
  properties: null, provenanceKind: null, provenanceRef: null, updatedAt: null, embedded: 0,
});

const SPORES = [
  spore('sp_a', 'run_4f1c9a2e7b', 'gotcha', 'Hosted and self-hosted order ties differently; sort by path too.', NOW - 2 * HOUR),
  spore('sp_b', 'run_4f1c9a2e7b', 'bug_fix', 'A test reserving a fixed port races the ephemeral fallback.', NOW - 2 * HOUR + 1),
  spore('sp_c', 'run_e0a4d2b917', 'decision', 'Myco’s work shows outcomes per task.', NOW - 7 * HOUR),
  spore('sp_d', 'run_e0a4d2b917', 'pattern', 'Every list takes its search from one filter bar.', NOW - 7 * HOUR + 1),
  spore('sp_e', 'run_e0a4d2b917', 'wisdom', 'Measure first paint on a phone profile.', NOW - 7 * HOUR + 2),
  spore('sp_f', 'run_e0a4d2b917', 'discovery', 'The close report scans every entry.', NOW - 7 * HOUR + 3),
  spore('sp_g', 'mem_q3Vb8xRk2LmT7wYz', 'decision', 'A spore an agent saved during a session.', NOW - 6 * HOUR),
];

const WORK: WorkAnswer = {
  window: { since: DAY_START, until: DAY_START + 24 * HOUR },
  outcomes: [],
  runs: RUNS,
  truncated: false,
  upkeep: { task: 'embedding-reconcile', lastSuccessAt: NOW - 80 * MINUTE, failedInWindow: 1, unrecovered: null },
};

const ATTENTION: AttentionAnswer = {
  items: [
    { kind: 'backup_overdue', tone: 'warn', lastBackupAt: NOW - 28 * 24 * HOUR, intervalHours: 24 },
    { kind: 'outcome_failed', tone: 'bad', projectId: P_MYCO, outcome: 'map', task: 'canopy-map', failures: 3, since: NOW - 8 * HOUR, latestAt: NOW - 8 * HOUR, runId: 'run_c19f7a0e55' },
    { kind: 'access_key_expiring', tone: 'warn', grantId: 'eg_1', projectId: P_GONE, label: null, expiresAt: NOW + 3 * 24 * HOUR },
  ],
  unavailable: [],
};

const CAPTURE: CaptureRow[] = [
  { machineId: 'mt_studio_machine', machineName: null, agent: 'claude-code', lastEventAt: NOW - MINUTE, projectId: P_MYCO },
  { machineId: 'mt_studio_machine', machineName: null, agent: 'codex', lastEventAt: NOW - 4 * HOUR, projectId: P_MYCO },
  { machineId: 'mt_buildbox_mach', machineName: null, agent: 'cursor', lastEventAt: NOW - 17 * HOUR, projectId: P_ATLAS },
];

type Routes = Record<string, (url: URL) => Response>;

const originalFetch = globalThis.fetch;
const originalMatchMedia = window.matchMedia;
let client: QueryClient;

beforeEach(() => { setSystemTime(new Date(NOW)); });
afterEach(() => {
  cleanup();
  client?.clear();
  globalThis.fetch = originalFetch;
  window.matchMedia = originalMatchMedia;
  setSystemTime();
  forgetProject();
});

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

const day = (over: Partial<Record<'sessions' | 'spores' | 'work' | 'attention' | 'status', unknown>> = {}, who: unknown = ADMIN): Routes => ({
  '/auth/me': () => Response.json(who),
  '/api/projects': () => Response.json({ projects: PROJECTS }),
  '/api/sessions': () => Response.json(over.sessions ?? { rows: SESSIONS, cursor: null }),
  '/api/spores': () => Response.json(over.spores ?? { spores: SPORES, total: SPORES.length, maxPage: 200 }),
  '/api/work': () => Response.json(over.work ?? WORK),
  '/api/attention': () => Response.json(over.attention ?? ATTENTION),
  '/api/status': () => Response.json(over.status ?? { capture: CAPTURE, unavailable: [], projects: [], workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 0, fleet: [] } }),
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

function screenWidth(width: number): void {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    const min = /min-width:\s*(\d+)px/.exec(query);
    const matches = (max === null || width <= Number(max[1])) && (min === null || width >= Number(min[1]));
    return { matches, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false };
  }) as typeof window.matchMedia;
}

const timeline = async () => screen.findByRole('list', { name: 'What happened' });
const items = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(':scope > li')];
const lede = () => document.querySelector('[data-lede]')!.textContent!;

describe('Today', () => {
  it('lands on / and merges the day\'s sessions with Myco\'s work, live first and then newest first', async () => {
    screenWidth(1280);
    const asked = server(day());
    mount('/');
    const list = await timeline();
    await waitFor(() => expect(items(list).length).toBe(8));
    const rows = items(list).map((li) => `${li.querySelector('time')!.textContent} ${li.textContent!.slice(li.querySelector('time')!.textContent!.length)}`);
    expect(rows.map((row) => row.split(' ')[0])).toEqual(['now', '14:00', '13:00', '11:00', '09:00', '08:00', '07:00', '06:00']);
    expect(rows[0]).toContain('Live');
    expect(rows[0]).toContain('Canopy parity verified');
    expect(rows[1]).toContain('Myco learned 2 spores from 3 sessions');
    expect(rows[2]).toContain('Myco titled 2 sessions');
    expect(rows[3]).toContain('Checkout errors rewritten');
    expect(rows[4]).toContain('Myco learned 5 spores from 4 sessions');
    expect(rows[5]).toContain('Myco couldn’t update the code map');
    // The heading is the day, and every read covers exactly it.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Tuesday, September 29');
    const work = asked.find((url) => url.pathname === '/api/work')!;
    expect([work.searchParams.get('since'), work.searchParams.get('until')]).toEqual([String(DAY_START), String(DAY_START + 24 * HOUR)]);
    for (const path of ['/api/sessions', '/api/spores']) {
      const read = asked.find((url) => url.pathname === path)!;
      expect([path, read.searchParams.get('since'), read.searchParams.get('until')]).toEqual([path, String(DAY_START), String(DAY_START + 24 * HOUR)]);
    }
    // The day's sessions are those active on it, whenever they started.
    expect(asked.find((url) => url.pathname === '/api/sessions')!.searchParams.get('window')).toBe('activity');
    // Each <time> carries the instant it names.
    expect(items(list)[1]!.querySelector('time')!.getAttribute('dateTime')).toBe(new Date(NOW - 2 * HOUR).toISOString());
    // Myco's items lead with the outcome and name the project after it; sessions lead with the project.
    expect(items(list)[1]!.querySelector('div > div')!.textContent).toBe('Myco learned 2 spores from 3 sessions·in Myco');
    expect(items(list)[3]!.querySelector('div > div')!.textContent!.startsWith('Atlas web')).toBe(true);
    expect(asked.some((url) => url.searchParams.has('project'))).toBe(false);
  });

  it('lists a session started yesterday and live now on today, says since when, and counts it in the lede', async () => {
    const overnight = session({ sessionId: '4fad4d99-ce7a-5142-b05f-af5b4b7d6e55', projectId: P_ATLAS, title: 'Overnight migration', label: 'Overnight migration', startedAt: DAY_START - 2 * HOUR - 20 * MINUTE, firstReceivedAt: DAY_START - 2 * HOUR - 20 * MINUTE, lastReceivedAt: NOW - 2 * MINUTE, endedAt: null });
    const endedToday = session({ sessionId: '5abe5eaa-df8b-5253-a16a-b06c5c8e7f66', projectId: P_MYCO, title: 'Late-night refactor', label: 'Late-night refactor', startedAt: DAY_START - HOUR, firstReceivedAt: DAY_START - HOUR, lastReceivedAt: DAY_START + HOUR, endedAt: DAY_START + HOUR });
    // An open session last heard from yesterday is not live, and was not active today.
    const idle = session({ sessionId: '6bcf6fbb-e09c-5364-b27d-c17d6d9f8077', projectId: P_MYCO, title: 'Left open last week', label: 'Left open last week', startedAt: DAY_START - 5 * 24 * HOUR, firstReceivedAt: DAY_START - 5 * 24 * HOUR, lastReceivedAt: DAY_START - 3 * HOUR, endedAt: null });
    // Open (no end recorded) and heard from this morning, but not for two hours: open is not live.
    const openQuiet = session({ sessionId: '7cd070cc-f1ad-5475-c38e-d28e7eaf9188', projectId: P_MYCO, title: 'Open but quiet', label: 'Open but quiet', startedAt: NOW - 4 * HOUR, firstReceivedAt: NOW - 4 * HOUR, lastReceivedAt: NOW - 2 * HOUR, endedAt: null });
    server(day({ sessions: { rows: [SESSIONS[1], overnight, endedToday, idle, openQuiet], cursor: null } }));
    mount('/');
    const list = await screen.findByRole('list', { name: 'What happened' });
    await waitFor(() => expect(within(list).getByText('Overnight migration')).toBeTruthy());
    const live = within(list).getByText('Overnight migration').closest('li')!;
    expect(live.getAttribute('data-timeline-item')).toBe('live');
    expect(live.querySelector('[data-started-earlier]')!.textContent).toBe('since yesterday 21:40');
    const ended = within(list).getByText('Late-night refactor').closest('li')!;
    expect(ended.querySelector('time')!.textContent).toBe('Sep 28');
    expect(ended.querySelector('[data-started-earlier]')!.textContent).toBe('since yesterday 23:00');
    expect(within(list).queryByText('Left open last week')).toBeNull();
    expect(within(list).getByText('Open but quiet').closest('li')!.getAttribute('data-timeline-item')).toBe('plain');
    expect(list.querySelectorAll('[data-timeline-item="live"]')).toHaveLength(1);
    expect(screen.getByText(/An agent is working/)).toBeTruthy();
    expect(document.querySelector('[data-lede]')!.textContent).toContain('4 sessions');
  });

  it('carries a learning run\'s spores inline, the rest as "and N more", and never the spores agents saved themselves', async () => {
    server(day());
    mount('/');
    const list = await timeline();
    const learned = within(list).getByText('Myco learned 5 spores from 4 sessions').closest('li')!;
    const lines = within(learned).getByRole('list', { name: 'Spores it wrote' });
    expect(within(lines).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'DecisionMyco’s work shows outcomes per task.',
      'PatternEvery list takes its search from one filter bar.',
      'WisdomMeasure first paint on a phone profile.',
      'and 2 more',
    ]);
    expect(within(list).queryByText('A spore an agent saved during a session.')).toBeNull();
    const titled = within(list).getByText('Myco titled 2 sessions').closest('li')!;
    expect(within(titled).getByRole('link', { name: 'Checkout errors rewritten' }).getAttribute('href')).toBe(`/p/${P_ATLAS}/sessions/1c7a1a66-9b47-5e1f-8d2c-7c2e1e4a3b22`);
    expect(within(titled).getByText('and 1 more')).toBeTruthy();
  });

  it('writes each failure beside its outcome, with the cause and what to do', async () => {
    server(day());
    mount('/');
    const list = await timeline();
    const map = within(list).getByText('Myco couldn’t update the code map').closest('li')!;
    expect(map.getAttribute('data-timeline-item')).toBe('bad');
    expect(map.textContent).toContain('Why: repo.sha256 is absent from the checkout.');
    expect(map.textContent).toContain('Open the run to see where it stopped.');
    expect(map.textContent!.match(/previous map is kept/g) ?? []).toHaveLength(0);
    expect(within(map).getByRole('link', { name: 'Open the run →' }).getAttribute('href')).toBe(`/p/${P_MYCO}/work/runs/run_c19f7a0e55`);
    const kept = within(list).getByText('Myco learned 2 spores from 3 sessions').closest('li')!;
    expect(kept.textContent).toContain('Stopped early: the run exceeded its turn budget.');
    expect(kept.textContent).toContain('What it saved is kept, so there’s nothing to do.');
  });

  it('counts the lede off the list it heads', async () => {
    server(day());
    mount('/');
    const list = await timeline();
    await waitFor(() => expect(document.querySelector('[data-lede]')).not.toBeNull());
    const sessionItems = items(list).filter((li) => li.querySelector('a')?.getAttribute('href')?.includes('/sessions/') && !li.textContent!.includes('Myco titled'));
    expect(lede()).toContain(`${sessionItems.length} sessions`);
    const learnedCounts = items(list).map((li) => /Myco learned (\d+) spores/.exec(li.textContent!)?.[1]).filter((n): n is string => n !== undefined).map(Number);
    expect(lede()).toContain(`Myco learned ${learnedCounts.reduce((a, b) => a + b, 0)} spores`);
    // Myco is named once: the spores' project is the one the live agent is in.
    expect(lede()).toBe('An agent is working in Myco right now. Today your agents ran 4 sessions in 3 projects, and Myco learned 7 spores.');
  });

  it('holds the lede to the timeline for any mix of entries', () => {
    const window = { start: DAY_START, end: DAY_START + 24 * HOUR };
    const entries = buildTimeline({ sessions: SESSIONS, runs: RUNS, spores: SPORES, window, now: NOW });
    const counts = ledeCounts(entries);
    expect(counts.sessions).toBe(entries.filter((e) => e.type === 'session').length);
    expect(counts.spores).toBe(entries.reduce((sum, e) => sum + (e.type === 'work' && (e.kind === 'learn' || e.kind === 'seed') ? e.runs.reduce((s, r) => s + (r.result === 'failed' ? 0 : r.outcome.spores), 0) : 0), 0));
    expect(counts.work).toBe(entries.filter((e) => e.type === 'work').length);
    // A run outside the day never reaches the list, so it never reaches the count.
    const outside = buildTimeline({ sessions: [], runs: [run({ id: 'run_yesterday1', kind: 'learn', task: 'extract-curate', at: DAY_START - 1, outcome: { spores: 9, sessions: 1, maps: 0 } })], spores: [], window, now: NOW });
    expect([outside.length, ledeCounts(outside).spores]).toEqual([0, 0]);
  });

  it('shows no raw id anywhere: unknown projects, Myco\'s own account, unnamed machines and untitled sessions all read in words', async () => {
    screenWidth(1280);
    server(day());
    mount('/');
    const list = await timeline();
    await screen.findByText('Needs you');
    await screen.findByRole('list', { name: /Agents on/ });
    expect(document.body.textContent).not.toMatch(RAW_ID);
    expect(within(list).getByText('A project')).toBeTruthy();
    // The live session has no title yet, so its first line heads it with an "Untitled" tag; the one headed only by its id shows no id.
    expect(within(list).getAllByText('Untitled session')).toHaveLength(1);
    expect(items(list)[0]!.querySelector('a')!.textContent).toBe('UntitledCanopy parity verified');
    const kickers = items(list).map((li) => li.querySelector('div > div')!.textContent);
    expect(kickers.filter((k) => k!.includes('Pi · Myco'))).toHaveLength(1);
    expect(kickers.filter((k) => k!.includes('Cursor · Lin'))).toHaveLength(1);
    expect(kickers.filter((k) => k!.includes('Claude Code on Ada’s studio Mac'))).toHaveLength(2);
    const capture = document.querySelector('[data-capture]')!;
    expect(capture.textContent).toContain('Machine 1');
    expect(capture.textContent).toContain('Machine 2 · Cursor, 17 h ago');
    expect(within(capture as HTMLElement).getByRole('img', { name: 'Sending now' })).toBeTruthy();
  });

  it('folds a project\'s title runs within an hour into one item, across a session between them, and keeps other projects\' apart', () => {
    const window = { start: DAY_START, end: DAY_START + 24 * HOUR };
    const title = (id: string, at: number, projectId = P_MYCO) => run({ id, kind: 'title', task: 'title-summary', at, projectId, outcome: { spores: 0, sessions: 1, maps: 0 } });
    const between = session({ sessionId: '4f0d4d99-ce7a-5142-b05f-af5b4b7d6e55', projectId: P_MYCO, startedAt: NOW - 3 * HOUR - 2 * MINUTE });
    const entries = buildTimeline({
      sessions: [between],
      runs: [title('run_ta00000001', NOW - 3 * HOUR), title('run_ta00000002', NOW - 3 * HOUR - 4 * MINUTE), title('run_ta00000003', NOW - 5 * HOUR), title('run_ta00000004', NOW - 3 * HOUR - MINUTE, P_ATLAS)],
      spores: [], window, now: NOW,
    });
    expect(entries.map((e) => (e.type === 'session' ? 'session' : `${e.projectId === P_MYCO ? 'myco' : 'atlas'}:${e.runs.length}`))).toEqual(['myco:2', 'atlas:1', 'session', 'myco:1']);
  });

  it('heads a session by its title without capture markup, and an untitled one as "Untitled session" with its first line, never its agent', async () => {
    screenWidth(1280);
    const at = (h: number) => ({ startedAt: NOW - h * HOUR, firstReceivedAt: NOW - h * HOUR });
    server(day({ sessions: { cursor: null, rows: [
      session({ sessionId: 'a0000000-0000-5000-8000-000000000001', projectId: P_MYCO, ...at(1), title: '<timestamp>Monday 09:12</timestamp> <user_query>Fix the release build</user_query>', label: 'x' }),
      session({ sessionId: 'a0000000-0000-5000-8000-000000000002', projectId: P_MYCO, ...at(2), title: null, label: 'claude-code', agent: 'claude-code' }),
      session({ sessionId: 'a0000000-0000-5000-8000-000000000003', projectId: P_MYCO, ...at(3), title: null, label: '<pasted_content id="df5c">Why does the map read differ', summary: '<user_query>Compared both targets.</user_query>' }),
      session({ sessionId: 'a0000000-0000-5000-8000-000000000004', projectId: P_MYCO, ...at(4), title: 'Named by id', memberId: 'mem_sirkirby_5a2d54af', memberLabel: 'sirkirby_5a2d54af', runtimeLabel: null }),
    ] }, work: { ...WORK, runs: [] } }));
    mount('/');
    const list = await timeline();
    await waitFor(() => expect(items(list)).toHaveLength(4));
    const [titled, agentOnly, pasted, byId] = items(list).map((li) => li.querySelector('a')!);
    expect(titled!.textContent).toBe('Fix the release build');
    expect(agentOnly!.textContent).toBe('Untitled session');
    expect(pasted!.textContent).toBe('UntitledWhy does the map read differ');
    expect(within(agentOnly!).getByText('Untitled session').className).toContain('text-muted');
    expect(list.textContent).toContain('Compared both targets.');
    expect(list.textContent).not.toMatch(/<\/?(timestamp|user_query|pasted_content)|claude-code|sirkirby_5a2d54af/);
    expect(byId!.closest('li')!.textContent).toContain('Claude Code');
  });

  it('strips capture markup and reads a label that is only an id as no name', () => {
    expect(cleanSessionText('<timestamp>Tue</timestamp>\n<user_query>\n  Ship it\n</user_query>')).toBe('Ship it');
    expect(cleanSessionText('<pasted_content id="a1">   ')).toBeNull();
    // Markup that is the person's own words, anywhere past the start, stays as written.
    expect(cleanSessionText('Fix <user_query> handling in capture')).toBe('Fix <user_query> handling in capture');
    expect(cleanSessionText('Fix `<user_query>` handling in capture')).toBe('Fix `<user_query>` handling in capture');
    expect(cleanSessionText('`<timestamp>` parsing drops the zone')).toBe('`<timestamp>` parsing drops the zone');
    // A timestamp cut off inside its block, or inside its own tag, leaves nothing of the person's.
    expect(cleanSessionText('<timestamp>Monday, September 28, 2026 09:1')).toBeNull();
    expect(cleanSessionText('<timesta')).toBeNull();
    expect(cleanSessionText('<timestamp')).toBeNull();
    // A closed paste goes whole, and the question after it is the heading; an unclosed one loses only its tag.
    expect(cleanSessionText('<pasted_content id="df5c">stack trace\nline 2</pasted_content>\nWhy does this fail on Linux?')).toBe('Why does this fail on Linux?');
    expect(cleanSessionText('<pasted_content id="df5c">Why does the map read differ')).toBe('Why does the map read differ');
    expect(cleanSessionText('<command-name>/model</command-name>')).toBe('/model');
    expect(cleanSessionText('<command-name>/review</command-name> <command-args>the parser</command-args>')).toBe('/review the parser');
    expect(sessionHeading({ sessionId: 's1', title: null, label: 's1', agent: null })).toEqual({ titled: false, firstPrompt: null });
    expect(memberLabel({ id: 'mem_sirkirby_5a2d54af', label: 'sirkirby_5a2d54af' })).toBeNull();
    expect(memberLabel({ id: 'mem_Hn5-pC0dJfA9sE_u', label: 'mem_Hn5-pC0dJfA9sE_u' })).toBeNull();
    expect(memberLabel({ id: 'mem_1', label: 'Ada' })).toBe('Ada');
    expect(memberDisplayName({ id: 'mem_sirkirby_5a2d54af', label: 'sirkirby_5a2d54af' }, 'sirkirby')).toBe('sirkirby');
    expect(memberDisplayName({ id: 'mem_x', label: null }, undefined)).toBe('You');
  });

  it('names the signed-in member in the account block by their login when their label is only their id', async () => {
    screenWidth(1280);
    server(day({}, { sub: '9', login: 'sirkirby', member: { id: 'mem_sirkirby_5a2d54af', label: 'sirkirby_5a2d54af', role: 'admin' } }));
    mount('/');
    expect(await screen.findByRole('button', { name: 'Account and appearance for sirkirby' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Navigation' }).textContent).not.toContain('sirkirby_5a2d54af');
  });

  it('names machines by name, and an unnamed one as a machine plus its agent', () => {
    const names = machineNames([
      { machineId: 'a', machineName: null },
      { machineId: 'b', machineName: 'Lin’s build box' },
      { machineId: 'c', machineName: '  ' },
    ]);
    expect([...names.values()]).toEqual(['Machine 1', 'Lin’s build box', 'Machine 2']);
    expect([...machineNames([{ machineId: 'a', machineName: null }, { machineId: 'b', machineName: 'Box' }]).values()]).toEqual(['A machine', 'Box']);
  });

  it('gives an admin "Needs you", each item with its problem, detail and one action', async () => {
    screenWidth(1280);
    server(day());
    mount('/');
    const panel = (await screen.findByText('Needs you')).closest('[data-needs-you]') as HTMLElement;
    const rows = [...panel.querySelectorAll('[data-needs-you-item]')];
    expect(rows.map((row) => row.querySelector('p')!.textContent)).toEqual([
      'Last backup was 28 days ago',
      '3 code map updates failed',
      'An access key expires in 3 days',
    ]);
    expect(within(panel).getByText('3')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'See the last attempt →' }).getAttribute('href')).toBe(`/p/${P_MYCO}/work/runs/run_c19f7a0e55`);
    expect(panel.textContent).toContain('In Myco.');
    expect(panel.textContent).toContain('In a project you can’t see here.');
  });

  it('says "Nothing needs you" in one line when nothing does, and names any check it could not read', async () => {
    screenWidth(1280);
    server(day({ attention: { items: [], unavailable: ['backup_overdue'] } }));
    mount('/');
    const heading = await screen.findByRole('heading', { name: 'Nothing needs you' });
    const panel = heading.closest('[data-needs-you]')!;
    expect(panel.querySelectorAll('[data-needs-you-item]')).toHaveLength(0);
    expect(panel.textContent).toBe('Nothing needs youCouldn’t check backups just now.');
  });

  it('never asks a member\'s browser for "Needs you", and shows them the rest', async () => {
    screenWidth(1280);
    const asked = server(day({}, MEMBER));
    mount('/');
    await timeline();
    await screen.findByRole('list', { name: /Agents on/ });
    expect(asked.some((url) => url.pathname === '/api/attention')).toBe(false);
    expect(document.querySelectorAll('[data-needs-you]')).toHaveLength(0);
    expect(screen.queryByText(/needs you/i)).toBeNull();
    expect(screen.queryByLabelText(/needs you/i)).toBeNull();
    expect(document.querySelector('[data-upkeep]')!.textContent).toBe('Search kept up to date · 1 h ago · 1 retry along the way');
  });

  it('keeps search upkeep to one quiet line, with Health for an admin', async () => {
    screenWidth(1280);
    server(day());
    mount('/');
    await timeline();
    const line = await waitFor(() => document.querySelector('[data-upkeep]') as HTMLElement);
    expect(within(line).getByRole('link', { name: 'Health →' }).getAttribute('href')).toBe('/status/health#upkeep');
    expect(within(line).getByRole('img', { name: 'Up to date' })).toBeTruthy();
  });

  it('says a quiet day in one line and links to yesterday, which reads that day and links back', async () => {
    const asked = server(day({ sessions: { rows: [], cursor: null }, work: { ...WORK, runs: [] }, spores: { spores: [], total: 0 } }));
    mount('/');
    expect(await screen.findByText('Nothing today')).toBeTruthy();
    const yesterday = screen.getByRole('link', { name: 'Yesterday’s work →' });
    expect(yesterday.getAttribute('href')).toBe(`/?day=${YESTERDAY}`);
    fireEvent.click(yesterday);
    expect(await screen.findByRole('heading', { level: 1, name: 'Monday, September 28' })).toBeTruthy();
    expect(await screen.findByText('Nothing this day')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to today' }).getAttribute('href')).toBe('/');
    const work = asked.filter((url) => url.pathname === '/api/work').at(-1)!;
    const start = new Date(2026, 8, 28).getTime();
    expect([work.searchParams.get('since'), work.searchParams.get('until')]).toEqual([String(start), String(DAY_START)]);
  });

  it('counts a past day\'s lede off that day alone, even when the server answers later sessions too', async () => {
    const yesterdayAt = (h: number) => ({ startedAt: DAY_START - h * HOUR, firstReceivedAt: DAY_START - h * HOUR, lastReceivedAt: DAY_START - h * HOUR + MINUTE, endedAt: DAY_START - h * HOUR + MINUTE });
    server(day({
      sessions: { cursor: null, rows: [
        ...SESSIONS,
        session({ sessionId: 'b0000000-0000-5000-8000-000000000001', projectId: P_MYCO, title: 'Yesterday one', ...yesterdayAt(2) }),
        session({ sessionId: 'b0000000-0000-5000-8000-000000000002', projectId: P_ATLAS, title: 'Yesterday two', ...yesterdayAt(5) }),
      ] },
      work: { ...WORK, runs: [] },
    }));
    mount(`/?day=${YESTERDAY}`);
    const list = await timeline();
    await waitFor(() => expect(items(list)).toHaveLength(2));
    expect(lede()).toBe('Your agents ran 2 sessions in Myco and Atlas web.');
  });

  it('says the day held more than it read instead of calling it quiet', async () => {
    let pages = 0;
    server({ ...day({ work: { ...WORK, runs: [] }, spores: { spores: [], total: 0 } }), '/api/sessions': () => { pages += 1; return Response.json({ rows: [], cursor: `c${pages}` }); } });
    mount('/');
    expect(await screen.findByText('This day held more than the timeline lists; the newest are shown.')).toBeTruthy();
    expect(screen.queryByText('Nothing today')).toBeNull();
    expect(pages).toBe(5);
  });

  it('links a code map update to the project\'s code map', async () => {
    server(day({ work: { ...WORK, runs: [run({ id: 'run_m0000000ok', kind: 'map', task: 'canopy-map', at: NOW - HOUR, outcome: { spores: 0, sessions: 0, maps: 1 } })] } }));
    mount('/');
    const list = await timeline();
    expect(within(list).getByRole('link', { name: 'Myco updated the code map' }).getAttribute('href')).toBe(`/p/${P_MYCO}/knowledge/map`);
  });

  it('asks again every 30 s while it shows today, never from a hidden tab, and not at all for a past day', async () => {
    server(day());
    mount('/');
    await timeline();
    await screen.findByText('Needs you');
    const observed = (key: string) => client.getQueryCache().findAll({ queryKey: [key] }).flatMap((query) => query.observers.map((o) => o.options));
    for (const key of ['today', 'work', 'attention', 'status']) {
      const options = observed(key);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        expect({ key, interval: option.refetchInterval, background: option.refetchIntervalInBackground }).toEqual({ key, interval: LIVE_REFRESH_MS, background: false });
      }
    }
    expect(LIVE_REFRESH_MS).toBe(30_000);
    cleanup();
    client.clear();
    server(day());
    mount(`/?day=${YESTERDAY}`);
    await screen.findByRole('heading', { level: 1, name: 'Monday, September 28' });
    for (const key of ['today', 'work']) for (const option of observed(key)) expect(option.refetchInterval).toBe(false);
  });

  it('narrows to one project at /p/:project, asking only for it, and marks Today in the nav', async () => {
    screenWidth(1280);
    const asked = server(day({ sessions: { rows: SESSIONS.filter((s) => s.projectId === P_MYCO), cursor: null } }));
    mount(`/p/${P_MYCO}`);
    const list = await timeline();
    for (const path of ['/api/sessions', '/api/spores', '/api/work']) {
      expect(asked.filter((url) => url.pathname === path).every((url) => url.searchParams.getAll('project').join() === P_MYCO)).toBe(true);
    }
    // One project needs no project name on each item.
    expect(within(list).queryByText('Myco')).toBeNull();
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect([...pages.querySelectorAll('a[aria-current="page"]')].map((a) => a.textContent)).toEqual(['Today']);
  });

  it('links Today in the nav to / on every project\'s Today form, and clearing the project filter leads back to it', async () => {
    screenWidth(1280);
    server(day());
    mount('/');
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('link', { name: 'Today' }).getAttribute('href')).toBe('/');
    expect(within(pages).getByRole('link', { name: 'Today' }).getAttribute('aria-current')).toBe('page');
    const filter = screen.getByRole('navigation', { name: 'Projects' });
    const myco = within(filter).getAllByRole('link').find((a) => a.textContent!.includes('Myco'))!;
    expect(myco.getAttribute('href')).toBe(`/p/${P_MYCO}`);
    fireEvent.click(myco);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/p/${P_MYCO}`));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Projects' })).getAllByRole('link').find((a) => a.textContent!.includes('Myco'))!);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/'));
  });

  it('puts "Needs you" in one line at the top on a phone, which opens to the items', async () => {
    screenWidth(390);
    server(day());
    mount('/');
    const summary = await screen.findByRole('button', { name: /3 things need you/ });
    expect(summary.textContent).toContain('Last backup was 28 days ago, and 2 more');
    const page = document.querySelector('[data-today]')!;
    expect(page.firstElementChild!.contains(summary)).toBe(true);
    fireEvent.click(summary);
    await waitFor(() => expect(page.querySelectorAll('[data-needs-you-item]')).toHaveLength(3));
  });

  it('shows the failed read in words with a retry, never an endless load', async () => {
    server({ ...day(), '/api/work': () => Response.json({ error: 'boom' }, { status: 503 }) });
    mount('/');
    expect(await screen.findByText('The server had a problem')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('Today\'s words', () => {
  it('reads a day parameter, and falls back to today for nothing, garbage or a day to come', () => {
    expect(dayWindow(null, NOW)).toMatchObject({ start: DAY_START, isToday: true, param: '2026-09-29', previous: YESTERDAY });
    expect(dayWindow(YESTERDAY, NOW)).toMatchObject({ start: new Date(2026, 8, 28).getTime(), end: DAY_START, isToday: false });
    for (const bad of ['2026-02-30', 'yesterday', '2026-09-30']) expect(dayWindow(bad, NOW).isToday).toBe(true);
    expect(dayParam(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
  });

  it('words every kind of "Needs you" item without an id, and gives each a place to act', () => {
    const items: AttentionItem[] = [
      ...ATTENTION.items,
      { kind: 'search_index_behind', tone: 'warn', pendingBlobs: 4, pendingSince: NOW - HOUR, failedUpdates: 0, failingSince: null, lastSuccessAt: NOW - 2 * HOUR },
      { kind: 'transcripts_stopped', tone: 'warn', projectId: P_ATLAS, transcripts: 2, latestAt: NOW, reasons: { parse_error: 2 } },
      { kind: 'runs_held_for_capability', tone: 'warn', capability: 'repository-checkout', runs: 1, since: NOW - HOUR },
      { kind: 'no_worker', tone: 'bad', runs: 4, since: NOW - 2 * HOUR, lastContactAt: NOW - 3 * HOUR },
      { kind: 'schema_mismatch', tone: 'bad', expected: 57, found: 56 },
      { kind: 'backup_overdue', tone: 'warn', lastBackupAt: null, intervalHours: 12 },
    ];
    const names = new Map(PROJECTS.map((p) => [p.projectId, p.name]));
    for (const item of items) {
      const words = attentionWords(item, NOW, (id) => names.get(id) ?? null);
      const text = `${words.title} ${words.detail} ${words.action?.label ?? ''}`;
      expect({ kind: item.kind, text }).not.toEqual({ kind: item.kind, text: expect.stringMatching(RAW_ID) });
      expect(words.action).not.toBeNull();
      expect(words.title.length).toBeGreaterThan(0);
    }
    expect(attentionWords(items[3]!, NOW, () => null).title).toBe('Search is falling behind');
    expect(attentionWords(items[5]!, NOW, () => null).detail).toContain('read the repository');
  });
});
