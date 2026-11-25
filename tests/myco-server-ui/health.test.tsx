import { backlogWords } from '../../packages/myco-server/ui/src/features/admin/health/words.js';
import { verdictOf, wellLines, type HealthFacts, type LineState, type WellLine } from '../../packages/myco-server/ui/src/features/admin/health/verdict';
import { backupFailedItems, backupUnchecked, storeCheckItems, storedKeyItems } from '../../packages/myco-server/ui/src/features/today/server-items';
import { harnessHealthWords } from '../../packages/myco-server/ui/src/features/today/words';
import type { StatusResponse } from '../../packages/myco-server/ui/src/lib/api';
/**
 * Health as two questions: whether the server is well, as one verdict over five lines, and what needs an admin, each
 * item with a way to finish it and, where there is one, a way to decline it. The parts that left Health are reached
 * from their old addresses; backups, their restore and the store checks are read where they live now.
 */
import { retiredBackupNotice } from '@goondocks/myco-shared/backup-words';
import { dashboardMe } from '../helpers/dashboard-permissions';
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { rawIdsIn } from '../helpers/raw-ids';

const NOW = Date.now();
const HOUR = 3_600_000;
const ADMIN = { sub: '583231', login: 'octocat', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '770001', login: 'lin', member: { id: 'mem_Hn5-pC0dJfA9sE_u', label: 'mem_Hn5-pC0dJfA9sE_u', role: 'member' as const } };
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const ATLAS = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const PROJECTS = { projects: [
  { projectId: MYCO, name: 'Myco', createdAt: 0, sessionCount: 12, lastActivityAt: NOW - 60_000, archivedAt: null, archivedBy: null },
  { projectId: ATLAS, name: 'Atlas web', createdAt: 0, sessionCount: 3, lastActivityAt: NOW - 86_400_000, archivedAt: NOW - 3_600_000, archivedBy: 'mem_q3Vb8xRk2LmT7wYz' },
] };

const STUDIO_CREDENTIAL = 'mt_4Kp9Qs2Vx7Lm0Zb1';
const BUSY_CREDENTIAL = 'mt_Ws8Yt3Nq6Rc2Hd5E';
const STRAY_CREDENTIAL = 'mt_Pz1Ga7Ue4Oi9Kj3F';
const runner = (name: string, display: string, extra: Record<string, unknown> = {}) => ({ runnerDetails: { id: name, name, state: 'enabled', display, lastSeenAt: NOW - 86_400_000, ...extra } });
const STATUS = {
  learning: { line: '2 sessions ready to learn (5 summaries to learn from); 3 turns waiting to be summarized; spent $2.00 of $20.00 in the last 24 hours.', lastCompleted: { at: NOW - 2 * 60_000, reason: 'learned' }, dueSessions: 2, turnsAwaitingCards: 3, state: 'ready' },
  budget: { active: true, reason: null, dailyUsd: 20, automaticUsd: 1.5, manualUsd: 0.5, liveUsd: 0, unconfirmed: null, heldHeads: null, pricedExposure: null, state: 'ready' },
  database: { readable: true },
  schema: { expected: 57, found: 57, matches: true }, target: 'bun',
  capabilities: [{ capability: 'blob-store', label: 'Blobs', present: true, operatorNames: ['MYCO_BLOBS'] }],
  workers: {
    available: true, workersBusy: 1, runsQueued: 2, recentWithinMs: 90_000,
    queue: { observedAt: NOW, count: 2, oldestAt: NOW - 18 * 60000, reasons: [{ reason: 'capacity', count: 2 }], nativeNeedsRunner: false },
    fleet: [runner('homelab-mini', 'Busy'), runner('studio', 'Offline')],
  },
  transcriptBacklog: { transcripts: 3, bytes: 4096, imported: { transcripts: 3, bytes: 4096 } },
  projects: [],
  capture: [
    { machineId: 'ada_5a2d54af', machineName: 'Ada’s studio Mac', member: { id: ADMIN.member.id, label: 'Ada' }, agent: 'claude-code', lastEventAt: NOW - 60_000, projectId: MYCO },
    { machineId: 'mini', machineName: null, member: { id: 'mem_harness', label: 'Myco' }, agent: 'codex', lastEventAt: NOW - 1_000, projectId: ATLAS },
  ],
  unavailable: [],
};
const credential = (id: string, machineId: string, runtimeLabel: string | null, memberId = ADMIN.member.id) => ({
  id, memberId, machineId, runtimeLabel, expiresAt: NOW + 86_400_000, revokedAt: null, revokedBy: null, bytesWritten: 0,
  lineageRoot: id, lineageStartedAt: NOW - 86_400_000, firstUsedAt: null, live: true, purpose: 'member',
});
/** A restore as the server answers it: running, complete or stopped. */
const restoreJob = (job: { state: 'running' | 'complete' | 'failed'; rowsDone: number; rowsTotal: number; completedAt?: number;
  outcome: { tables: Record<string, { rows: number; inserted: number; skipped?: string }> }; failure?: { code: string; message: string } }) => ({
  id: 'rs_1', backupId: 'bk_7f3a9c0e21', acceptedAt: NOW, completedAt: null, failure: null, retrying: null, awaitingDocuments: false, ...job });
const BACKUP = { id: 'bk_7f3a9c0e21', key: 'backups/1.sqlite', created_at: NOW - 28 * 86_400_000, size_bytes: 48_213_504, counts_json: '{}', schema_version: 57, producer: 'mem_q3Vb8xRk2LmT7wYz', pinned: 0, verification: { state: 'verified', checkedAt: 0, detail: null } };

type Route = (init?: RequestInit) => Response;

const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  '/auth/me': () => Response.json(dashboardMe(ADMIN)),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/status': () => Response.json(STATUS),
  '/api/attention': () => Response.json({ items: [{ kind: 'backup_overdue', tone: 'warn', lastBackupAt: BACKUP.created_at, intervalHours: 24 }], unavailable: [] }),
  '/api/credentials': () => Response.json({ rows: [credential(STUDIO_CREDENTIAL, 'ada_5a2d54af', 'Ada’s studio Mac'), credential(BUSY_CREDENTIAL, 'lin_9e8f7a6b', 'Lin’s build box', 'mem_Hn5-pC0dJfA9sE_u')], cursor: null }),
  '/api/machines': () => Response.json({ machines: [
    { machineId: 'ada_5a2d54af', name: 'Ada’s studio Mac', live: true, canStop: true, stopReason: null, member: { id: ADMIN.member.id, label: 'Ada', revoked: false }, claimedAt: NOW - 86_400_000, credentialCount: 1, liveCredentialCount: 1, bytesWritten: 0, firstSeenAt: NOW - 86_400_000, standing: 'allowed', stoppedBy: null, offers: null, lastContactAt: null, capture: [], lastCaptureAt: null, lastRunAt: null },
    { machineId: 'lin_9e8f7a6b', name: 'Lin’s build box', live: true, canStop: true, stopReason: null, member: { id: MEMBER.member.id, label: null, revoked: false }, claimedAt: NOW - 86_400_000, credentialCount: 1, liveCredentialCount: 1, bytesWritten: 0, firstSeenAt: NOW - 86_400_000, standing: 'allowed', stoppedBy: null, offers: null, lastContactAt: null, capture: [], lastCaptureAt: null, lastRunAt: null },
  ], cursor: null }),
  '/api/backups': () => Response.json({ backups: [BACKUP] }),
  '/api/recovery/exports': () => Response.json({ supported: false, reason: 'this Deployment runs no hosted recovery producer', schedule: { unreadable: 'not read' } }),
  '/api/work': () => Response.json({ window: { since: 0, until: 0 }, state: 'ready', summary: [], timeline: [], hasMore: false, cursor: null, maps: [], upkeep: { task: 'embedding-reconcile', lastSuccessAt: NOW - 3_600_000, failedInWindow: 2, unrecovered: null } }),
  '/api/maintenance': () => Response.json({ checks: [] }),
  '/api/work/now': () => Response.json({ observedAt: NOW, scope: 'deployment', unavailable: [], marks: { runs: 'r', sessions: 's', knowledge: 'k', recovery: 'b', fleet: 'f' }, projects: { read: 1, total: 1, hasMore: false, cursor: null }, runningTotal: 1, runningHasMore: false,
    running: [{ runId: 'run_4f1c9a2e7b', projectId: MYCO, task: 'extract-curate', what: 'Learn from sessions', machine: 'homelab-mini', runnerId: null, heardAt: null, harness: 'codex', model: null, startedAt: NOW - 60_000, step: { words: 'Read session cards', at: NOW - 5_000 } }],
    waiting: [{ key: 'budget', projectId: null, what: 'Automatic work', count: null, why: 'Paused until the rolling 24-hour budget has room: $1.00 of $1.00 spent.', since: null, nextAt: null }],
    needsYou: [{ key: 'sign-in:rn_mini', projectId: null, what: 'homelab-mini can’t sign in to a coding agent', why: 'Sign in to a coding agent on this runner.', at: NOW, runId: null, retryAt: null }] }),
  '/api/settings': () => Response.json({ leaves: [], taskTiers: [], embedding: null, quickJobs: { answeredBy: 'included', offered: ['included'] } }),
  '/api/uncaptured': () => Response.json({ items: [], cursor: null }),
  '/api/runners/agents': () => Response.json({ agents: [], today: [{ id: 'homelab-mini', name: 'homelab-mini', agent: 'claude-code' }, { id: 'studio', name: 'studio', agent: 'claude-code' }] }),
  '/api/embedding/passed-over': () => Response.json({ state: 'ready', count: 0, sources: [] }),
  '/api/embedding/switch': () => Response.json({ switch: null }),
  '/api/kpis': () => Response.json({
    state: 'ready', windowStart: 1697328000000, windowEnd: 1700006399999, asOf: 1700000000000, metricVersion: 711, windowDays: 30, since: 0, promptsServed: 2, deliveries: { placed: 2, unplaced: 1 }, servedShare: { value: 0.5, sampleSize: 4 }, sporeServeRate: { value: null, sampleSize: 0 }, sessionStartPresent: { value: null, sampleSize: 0 }, callsPerPrompt: { value: null, sampleSize: 0 },
    callsPerPromptByHarness: [], planReadsPerSession: { value: null, sampleSize: 0 }, firstInjectionMs: { value: null, sampleSize: 0 }, recallQuality: { value: null, sampleSize: 0 }, promptIdentity: [],
  }),
  ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(table: Record<string, Route>): { asked: string[]; posts: Array<{ path: string; body: unknown }> } {
  const asked: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return table[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked, posts };
}

let seen = { pathname: '', search: '', hash: '' };
function Where() {
  const location = useLocation();
  seen = { pathname: location.pathname, search: location.search, hash: location.hash };
  return null;
}

function mount(path = '/status/health', client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

async function openMenu(name: string | RegExp, scope: HTMLElement = document.body) {
  fireEvent.keyDown(await within(scope).findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
}

const BACKUPS = '/settings/advanced#backups';
const UPKEEP = '/settings/advanced#upkeep';

const WORK = { running: [{ runId: 'r', projectId: MYCO, task: 'extract-curate' }], waiting: [], needsYou: [], unavailable: [] } as unknown as NonNullable<HealthFacts['work']['data']>;
const PAYERS = { agents: [], today: [{ id: 'homelab-mini', name: 'homelab-mini', agent: 'claude-code' }, { id: 'studio', name: 'studio', agent: 'claude-code' }] };
/** A read that answered and has not failed since. */
const READ = { failed: false, pending: false };
const QUIET = { '/api/attention': () => Response.json({ items: [], unavailable: [] }) };
/** The lines Health reads from `STATUS` changed by `over`, with every other fact well unless `facts` says otherwise. */
const linesOf = (over: Partial<StatusResponse> = {}, facts: Partial<HealthFacts> = {}): WellLine[] => wellLines({
  now: NOW, projectName: (id) => (id === MYCO ? 'Myco' : null), server: [], unchecked: [], checking: [],
  status: { data: { ...STATUS, ...over } as unknown as StatusResponse, ...READ },
  attention: { data: { items: [], unavailable: [] }, ...READ },
  work: { data: WORK, ...READ }, payers: { data: PAYERS, ...READ }, ...facts,
});
const stateOf = (lines: readonly WellLine[]): Record<string, LineState> => Object.fromEntries(lines.map((line) => [line.key, line.state]));
const verdictFor = async (): Promise<HTMLElement> => {
  const well = await screen.findByRole('region', { name: 'Is the server well?' });
  await waitFor(() => expect(well.querySelector('[data-verdict]')).not.toBeNull());
  return well;
};

describe('Health', () => {
  it('asks two questions in order, keeps the diagnostics at its foot, and says in one line where the rest went', async () => {
    server(routes());
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    const page = document.querySelector('[data-admin-page="health"]')!;
    expect([...page.querySelectorAll(':scope > section')].map((s) => s.id)).toEqual(['status', 'needs-you']);
    expect((await screen.findByTestId('download-diagnostics')).getAttribute('href')).toBe('/api/diagnostics');
    const moved = page.querySelector('[data-health-moved]')!;
    expect([...moved.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Backups', BACKUPS], ['Upkeep', UPKEEP], ['Is Myco helping?', '/measures'],
    ]);
    expect(page.textContent).not.toContain('Installed agents');
    expect(page.textContent).not.toContain('What each project last sent');
  });

  it('says Yes when every line is, each from its own read, by machine and project name', async () => {
    server(routes(QUIET));
    mount();
    const well = await verdictFor();
    await waitFor(() => expect(well.querySelector('[data-verdict]')!.textContent).toBe('YesSessions are arriving, Myco is learning from them, and 1 of 2 runners can work.'));
    const line = (key: string) => well.querySelector(`[data-well-line="${key}"]`)!.textContent;
    expect(line('sessions')).toBe('Sessions arrivingLast capture received 1 min ago, from Ada’s studio Mac for Myco.Yes');
    expect(line('learning')).toContain('Last learning completed 2 min ago.');
    expect(line('learning')).toContain(STATUS.learning.line);
    expect(line('learning')).toContain('3 transcripts (4.0 KB) waiting to be read into sessions.');
    expect(line('learning')).toContain('Running now: learning.');
    expect(line('runners')).toBe('Somewhere to runhomelab-mini can work and is working. studio is offline, last seen yesterday.1 of 2 can work');
    expect(line('budget')).toContain('$2.00 counts against it now');
    expect(line('database')).toBe('Database and storageAnswering, at the version this server expects (57). Its storage is set up; stored files are not read back here.Yes');
    expect(well.textContent).not.toContain('MYCO_BLOBS');
  });

  it('reads each line to the worst of its facts, failures Myco retries and items that need you included', () => {
    expect(stateOf(linesOf())).toEqual({ sessions: 'yes', learning: 'yes', runners: 'yes', budget: 'yes', database: 'yes' });
    const attention = (...items: unknown[]): Partial<HealthFacts> => ({ attention: { data: { items, unavailable: [] } as never, ...READ } });
    const finding = { runId: 'c', trigger: 'schedule', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null, findings: ['x'], findingsOmitted: 0, measurements: [] } as const;
    const work = (data: unknown): Partial<HealthFacts> => ({ work: { data: { waiting: [], needsYou: [], unavailable: [], ...(data as object) } as never, ...READ } });
    const cases: Array<[string, Partial<StatusResponse>, Partial<HealthFacts>, Record<string, LineState>]> = [
      ['nothing from a person lately', { capture: [STATUS.capture[1]!] } as Partial<StatusResponse>, {}, { sessions: 'unknown' }],
      ['the last receipt two days old', { capture: [{ ...STATUS.capture[0]!, lastEventAt: NOW - 2 * 86_400_000 }] } as Partial<StatusResponse>, {}, { sessions: 'unknown' }],
      ['a transcript that stopped being read', {}, attention({ kind: 'transcripts_stopped', tone: 'warn', projectId: MYCO, transcripts: 1, latestAt: NOW, reasons: {} }), { sessions: 'attention' }],
      ['learning counts still building', { learning: { ...STATUS.learning, state: 'building' } } as Partial<StatusResponse>, {}, { learning: 'unknown' }],
      ['a backlog waiting for its schedule, nothing running', {}, work({ running: [], waiting: [{ key: 'b', what: 'Learning', why: 'It starts when the server next checks.' }] }), {}],
      ['due learning no machine has taken', {}, work({ running: [], needsYou: [{ key: `unclaimed:${MYCO}:extract-curate`, what: 'Learning has waited 3 h with no machine taking it', why: 'x' }] }), { learning: 'attention' }],
      ['what Myco is doing only partly read', {}, work({ running: [], unavailable: ['waiting'] }), { learning: 'unknown' }],
      ['what Myco is doing not answered yet', {}, { work: { data: undefined, failed: false, pending: true } }, { learning: 'pending' }],
      ['what needs you not answered yet', {}, { attention: { data: undefined, failed: false, pending: true } }, { sessions: 'pending', learning: 'pending', runners: 'pending', database: 'pending' }],
      ['what needs you read before a refresh that failed', {}, { attention: { data: { items: [], unavailable: [] }, failed: true, pending: false } }, { sessions: 'unknown', learning: 'unknown', runners: 'unknown', database: 'unknown' }],
      ['the store checks not answered yet', {}, { checking: ['store checks'] }, { database: 'pending' }],
      ['no runner set up, and nothing said to wait for one', { workers: { ...STATUS.workers, fleet: [] } } as unknown as Partial<StatusResponse>, {}, {}],
      ['which agent runners can use read before a refresh that failed', {}, { payers: { data: PAYERS, failed: true, pending: false } }, { runners: 'unknown' }],
      ['a learning failure Myco is retrying', {}, attention({ kind: 'outcome_failed', tone: 'bad', projectId: MYCO, outcome: 'learn', task: 'extract-curate', failures: 3, since: NOW, latestAt: NOW, runId: 'r', retrying: true }), { learning: 'attention' }],
      ['no runner online', { workers: { ...STATUS.workers, fleet: [runner('studio', 'Offline')] } } as unknown as Partial<StatusResponse>, {}, { runners: 'no' }],
      ['an online runner with no agent it can use', {}, { payers: { data: { agents: [], today: [{ id: 'homelab-mini', name: 'homelab-mini', agent: null }] }, ...READ } }, { runners: 'no' }],
      ['work waiting on a rejected key', {}, { server: storedKeyItems({ ...STATUS, workers: { ...STATUS.workers, fleet: [runner('homelab-mini', 'Busy', { storedKeyFailures: [{ agent: 'claude-code', slot: 'anthropic', failure: 'invalid_key' }] })] } } as unknown as StatusResponse) }, { runners: 'attention' }],
      ['runners on their own sign-in after a rejected key', {}, { server: storedKeyItems({ ...STATUS, workers: { ...STATUS.workers, fleet: [runner('homelab-mini', 'Busy', { fallbackNotices: [{ agent: 'claude-code', slot: 'anthropic', reason: 'invalid_key', since: NOW }] })] } } as unknown as StatusResponse) }, {}],
      ['no queue fact', { workers: { ...STATUS.workers, queue: undefined } } as unknown as Partial<StatusResponse>, {}, { runners: 'unknown' }],
      ['the budget reached', { budget: { ...STATUS.budget, automaticUsd: 20 } } as Partial<StatusResponse>, {}, { budget: 'attention' }],
      ['a task held for the budget', { budget: { ...STATUS.budget, heldHeads: [{ projectId: MYCO, runId: 'r', task: 'extract-curate', reason: 'budget_too_small', requiredUsd: 25, quotedAt: NOW }] } } as Partial<StatusResponse>, {}, { budget: 'attention' }],
      ['the database not answering', { database: { readable: false } }, {}, { database: 'no' }],
      ['no storage reported', { capabilities: [] }, {}, { database: 'unknown' }],
      ['the store checks unread', {}, { unchecked: ['store checks'] }, { database: 'unknown' }],
      ['an integrity finding', {}, { server: storeCheckItems({ checks: [{ check: 'integrity', support: { supported: true, label: 'x' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: finding }] }) }, { database: 'attention' }],
      ['failed reads', { unavailable: ['capture', 'learning', 'workers', 'budget', 'schema'] }, {}, { sessions: 'failed', learning: 'failed', runners: 'failed', budget: 'failed', database: 'failed' }],
    ];
    for (const [name, over, facts, changed] of cases) {
      expect({ name, states: stateOf(linesOf(over, facts)) }).toEqual({ name, states: { ...stateOf(linesOf()), ...changed } });
    }
    expect(linesOf({ budget: { ...STATUS.budget, active: false, reason: 'turned off' } } as Partial<StatusResponse>)[3]!.answer).toBe('Not applied');
  });

  it('keeps a store check’s finding while it runs again, and says a failed backup only once it ended failed', () => {
    const finding = { runId: 'c', trigger: 'schedule', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null, findings: ['x'], findingsOmitted: 0, measurements: [] } as const;
    const running = { check: 'integrity', support: { supported: true, label: 'x' }, cadence: { state: 'off' }, dueAt: null, running: true, latest: { ...finding, state: 'running', finishedAt: null } } as const;
    expect(storeCheckItems({ checks: [running] }, new Map([['integrity', finding]])).map((item) => item.kind === 'store_check' && item.rerunning)).toEqual([true]);
    const producer = (stage: string, schedule: unknown) => ({ supported: true, attempt: 4, stage, form: 'staging', error: 'export_failed', schedule }) as never;
    const latest = (stage: string) => ({ supported: true, configured: true, ready: true, intervalHours: 24, dueAt: null, due: false, latest: { attempt: 4, stage, startedAt: NOW, failure: null }, available: { state: 'none' }, idleBecause: null });
    expect(backupFailedItems(producer('export', latest('export')))).toEqual([]);
    expect(backupFailedItems(producer('failed', latest('failed')))).toHaveLength(1);
    expect([backupFailedItems(producer('failed', { unreadable: 'x' })).length, backupUnchecked(producer('export', { unreadable: 'x' }))]).toEqual([1, true]);
    expect(backupUnchecked({ supported: false, reason: 'none here', schedule: { unreadable: 'x' } } as never)).toBe(false);
  });

  it('lowers the verdict for an integrity finding, a failure Myco retries and quiet capture, while each line’s own read is well', async () => {
    const finding = { runId: 'c1', trigger: 'schedule', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null, findings: ['A stored record is missing.'], findingCodes: ['store_problem'], findingsOmitted: 0, measurements: [] };
    server(routes({
      '/api/maintenance': () => Response.json({ checks: [{ check: 'integrity', support: { supported: true, label: 'Checks stored records' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: finding }] }),
      '/api/attention': () => Response.json({ items: [{ kind: 'outcome_failed', tone: 'bad', projectId: ATLAS, outcome: 'learn', task: 'extract-curate', failures: 3, since: NOW - HOUR, latestAt: NOW, runId: 'run_c19f7a0e55', retrying: true }], unavailable: [] }),
      '/api/status': () => Response.json({ ...STATUS, capture: [{ ...STATUS.capture[0]!, lastEventAt: NOW - 2 * 86_400_000 }] }),
    }));
    mount();
    const well = await verdictFor();
    await waitFor(() => expect(well.querySelector('[data-verdict]')!.textContent)
      .toBe('Needs attentionNeeds a look: sessions arriving (quiet), learning from them, database and storage.'));
    const line = (key: string) => well.querySelector(`[data-well-line="${key}"]`)!;
    expect(line('database').textContent).toContain('Answering, at the version this server expects (57).');
    expect(line('database').textContent).toContain('Integrity check found a problem.');
    expect(line('learning').textContent).toContain('Last learning completed 2 min ago.');
    expect(line('learning').textContent).toContain('3 learning attempts failed.');
    expect(line('sessions').textContent).toContain('Quiet since then. Last capture received 2 days ago');
    expect(within(screen.getByRole('region', { name: 'What needs you' })).queryByText('3 learning attempts failed')).toBeNull();
  });

  it('gives No when any line is No, Needs attention when any is unsure, Checking while a read has yet to answer, and Yes only when all are Yes', () => {
    const lines = linesOf();
    const withStates = (...states: LineState[]) => lines.map((line, index) => ({ ...line, state: states[index] ?? 'yes' }));
    for (const [states, verdict] of [
      [[], 'Yes'], [['attention'], 'Needs attention'], [['unknown'], 'Needs attention'], [['failed'], 'Needs attention'],
      [['yes', 'no'], 'No'], [['attention', 'no', 'failed'], 'No'], [['pending'], 'Checking'], [['pending', 'attention'], 'Needs attention'], [['pending', 'no'], 'No'],
    ] as const) expect({ states, verdict: verdictOf(withStates(...states)).verdict }).toEqual({ states, verdict });
    expect(verdictOf(withStates('yes', 'yes', 'no', 'attention')).sentence).toBe('Not working: somewhere to run (1 of 2 can work). Needs a look: within budget (yes).');
  });

  it('says on every line that a failed status read failed, never says Yes, and keeps saying so while it reads again', async () => {
    let answered = 0;
    server(routes({ '/api/status': () => (answered++ === 0 ? Response.json({ error: 'unavailable' }, { status: 503 }) : new Promise<Response>(() => undefined) as unknown as Response) }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount('/status/health', client);
    const well = await verdictFor();
    expect(well.querySelector('[data-verdict] p')!.textContent).toBe('Needs attention');
    expect([...well.querySelectorAll('[data-well-state="failed"]')]).toHaveLength(5);
    expect(well.textContent).toContain('Couldn’t read this server’s status just now.');
    void client.refetchQueries({ queryKey: ['status'] });
    await waitFor(() => expect(answered).toBe(2));
    expect([...well.querySelectorAll('[data-well-state="failed"]')]).toHaveLength(5);
  });

  it('shows what needs an admin with a way to finish and decline it, and its count beside Health in the nav', async () => {
    server(routes());
    mount();
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    expect(await within(needsYou).findByText(/^Last backup was /)).toBeTruthy();
    expect(within(needsYou).getByRole('link', { name: /Open backups/ }).getAttribute('href')).toBe(BACKUPS);
    expect(within(needsYou).getByRole('link', { name: /Change how often it runs/ }).getAttribute('href')).toBe('/settings/advanced#backup');
    const admin = screen.getByRole('navigation', { name: 'Admin' });
    expect(await within(admin).findByRole('link', { name: 'Health, 1 thing needs you' })).toBeTruthy();
  });

  it('says one count in the list and beside Health, counting the repositories not captured yet', async () => {
    server(routes({
      '/api/uncaptured': () => Response.json({ items: [{ machineId: 'mt_studio_machine', machineName: 'Ada’s studio Mac', member: { id: 'mem_ada', label: 'Ada' }, rootKey: 'a1b2c3d4e5f60718',
        label: 'widget', remote: 'github.com/acme/widget', reason: 'outside_folders', misses: 3, held: 'held', firstSeenAt: NOW - 86_400_000, lastSeenAt: NOW - 7_200_000 }], cursor: null }),
    }));
    mount();
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    await within(needsYou).findByText(/widget/);
    expect(needsYou.querySelector('h2')!.parentElement!.textContent).toBe('What needs you2');
    expect(await within(screen.getByRole('navigation', { name: 'Admin' })).findByRole('link', { name: 'Health, 2 things need you' })).toBeTruthy();
  });

  it('lists a store check that found a problem, a rejected stored key and a failed automatic backup said once with its overdue schedule, counted beside Health', async () => {
    const finding = { runId: 'c1', trigger: 'schedule', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null, findings: ['A stored record is missing.'], findingCodes: ['store_problem'], findingsOmitted: 0, measurements: [] };
    server(routes({
      '/api/maintenance': () => Response.json({ checks: [{ check: 'integrity', support: { supported: true, label: 'Checks stored records' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: finding }] }),
      '/api/status': () => Response.json({ ...STATUS, workers: { ...STATUS.workers, fleet: [
        runner('homelab-mini', 'Online', { storedKeyFailures: [{ agent: 'claude-code', slot: 'anthropic', failure: 'invalid_key' }] }),
        runner('studio', 'Online', { fallbackNotices: [{ agent: 'claude-code', slot: 'anthropic', reason: 'invalid_key', since: NOW }, { agent: 'codex', slot: 'codex', reason: 'out_of_credit', since: NOW }] }),
      ] } }),
      '/api/recovery/exports': () => Response.json({ supported: true, attempt: 4, stage: 'failed', form: 'staging', error: 'export_failed',
        schedule: { supported: true, configured: true, ready: true, intervalHours: 24, dueAt: null, due: false, latest: { attempt: 4, stage: 'failed', startedAt: NOW, failure: 'export_failed' }, available: { state: 'none' }, idleBecause: null } }),
    }));
    mount();
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    const item = async (title: string) => (await within(needsYou).findByText(title)).closest('li')!;
    const links = (li: HTMLElement) => [...li.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links(await item('Integrity check found a problem'))).toEqual([['See what it found, and run it again →', UPKEEP], ['Change when it runs →', '/settings/advanced#maintenance']]);
    const key = await item('The Anthropic key was rejected');
    expect(key.textContent).toContain('Seen by homelab-mini and studio.');
    expect(links(key)).toEqual([['Replace the key →', '/settings/connections#credentials'], ['Change who pays on Runners →', '/work/runners']]);
    expect((await item('The last automatic backup failed')).textContent).toContain('Attempt 4');
    expect(within(needsYou).queryByText(/^Last backup was /)).toBeNull();
    expect(within(needsYou).queryByText(/Codex \(OpenAI\) key/)).toBeNull();
    expect(await within(screen.getByRole('navigation', { name: 'Admin' })).findByRole('link', { name: 'Health, 3 things need you' })).toBeTruthy();
  });

  it('turns off, for the item’s project alone, the switch that gates it: an untouched code map, and the switch a failing task runs under', async () => {
    const puts: Array<{ path: string; body: unknown; match: string | null }> = [];
    const put = (capability: string): Route => (init) => {
      puts.push({ path: capability, body: JSON.parse(String(init!.body)), match: new Headers(init!.headers).get('if-match') });
      return Response.json({ applied: true });
    };
    server(routes({
      '/api/attention': () => Response.json({ items: [
        { kind: 'repository_missing', tone: 'warn', projectId: MYCO, codeMap: true },
        { kind: 'outcome_failed', tone: 'bad', projectId: MYCO, outcome: 'learn', task: 'curate-spores', failures: 2, since: NOW - HOUR, latestAt: NOW, runId: 'run_c19f7a0e55', retrying: false },
      ], unavailable: [] }),
      '/api/tasks': () => Response.json({ tasks: [{ task: 'extract-curate', capability: 'vault_evolution' }, { task: 'curate-spores', capability: 'spore_curation' }] }),
      [`/api/projects/${MYCO}/capabilities`]: () => Response.json({ capabilities: { canopy: true, vault_evolution: true, spore_curation: true, cortex: true }, settings: { 'curation.daily_cluster_limit': 3 }, revisions: {}, capabilityRevisions: {} }),
      [`/api/projects/${MYCO}/capabilities/canopy`]: put('canopy'),
      [`/api/projects/${MYCO}/capabilities/spore_curation`]: put('spore_curation'),
    }));
    mount();
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    for (const [label, done] of [['Turn the code map off', 'The code map is off for Myco.'], ['Turn curate overlapping spores off here', 'Curate overlapping spores is off for Myco.']] as const) {
      const off = await within(needsYou).findByRole('button', { name: label });
      await waitFor(() => expect(off.hasAttribute('disabled')).toBe(false));
      fireEvent.click(off);
      expect(await within(needsYou).findByText(done)).toBeTruthy();
    }
    expect(puts).toEqual([{ path: 'canopy', body: { enabled: false }, match: '0' }, { path: 'spore_curation', body: { enabled: false }, match: '0' }]);
  });

  it('keeps an item read before when a refresh fails, and says the check could not be read, with a retry', async () => {
    let fail = false;
    const finding = { runId: 'c1', trigger: 'schedule', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null, findings: ['x'], findingCodes: ['store_problem'], findingsOmitted: 0, measurements: [] };
    server(routes({ ...QUIET, '/api/maintenance': () => (fail ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json({ checks: [{ check: 'integrity', support: { supported: true, label: 'x' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: finding }] })) }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mount('/status/health', client);
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    await within(needsYou).findByText('Integrity check found a problem');
    fail = true;
    await client.refetchQueries({ queryKey: ['maintenance'] });
    await waitFor(() => expect(needsYou.textContent).toContain('Couldn’t check store checks just now.'));
    expect(within(needsYou).getByText('Integrity check found a problem')).toBeTruthy();
    expect(within(needsYou).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(document.querySelector('[data-well-line="database"]')!.textContent).toContain('Couldn’t check store checks just now.');
  });

  it('words a transcript that stopped being read with its next step, and no raw id', async () => {
    server(routes({
      '/api/attention': () => Response.json({ items: [{ kind: 'transcripts_stopped', tone: 'warn', projectId: MYCO, transcripts: 2, latestAt: NOW,
        reasons: { parse: 2 }, latestDiagnostic: { branch: 'no_progress', offset: 12345, lineKind: 'tool_result' } }], unavailable: [] }),
    }));
    mount();
    const needsYou = await screen.findByRole('region', { name: 'What needs you' });
    const item = (await within(needsYou).findByText('2 transcripts couldn’t be read')).closest('li')!;
    expect(item.textContent).toContain('Reading could not move past a record (tool result).');
    expect(item.textContent).toContain('Update Myco');
    expect(item.textContent).not.toContain('12345');
    expect(rawIdsIn(item)).toEqual([]);
  });

  it('asks for its own reads at once, without waiting on the projects list', async () => {
    const { asked } = server(routes({ '/api/projects': () => new Promise<Response>(() => undefined) as unknown as Response }));
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    await waitFor(() => {
      const missing = ['/api/status', '/api/attention', '/api/maintenance', '/api/recovery/exports']
        .filter((path) => !asked.some((line) => line === `GET ${path}` || line.startsWith(`GET ${path}?`)));
      expect(missing).toEqual([]);
    });
  });

  it('leads each old address of a part that left to where it lives now, with its content there', async () => {
    for (const [from, to, content] of [
      ['/status/health#backups', { pathname: '/settings/advanced', search: '', hash: '#backups' }, () => screen.findByRole('heading', { name: 'Backups made here' })],
      ['/status/health#upkeep', { pathname: '/settings/advanced', search: '', hash: '#upkeep' }, () => screen.findByRole('button', { name: 'Run housekeeping now' })],
      ['/status/health?window=7#measures', { pathname: '/measures', search: '?window=7', hash: '' }, () => screen.findByRole('heading', { level: 1, name: 'Is Myco helping?' })],
      ['/status', { pathname: '/status/health', search: '', hash: '#status' }, () => screen.findByRole('region', { name: 'Is the server well?' })],
      ['/status/health#%', { pathname: '/status/health', search: '', hash: '#%' }, () => screen.findByRole('region', { name: 'Is the server well?' })],
    ] as const) {
      server(routes());
      mount(from);
      await waitFor(() => expect(seen).toEqual(to));
      expect(await content()).toBeTruthy();
      cleanup();
    }
  });

  it('restores a backup only through its confirm, and one from another Deployment only once the switch is on', async () => {
    const { posts } = server(routes({
      '/auth/me': () => Response.json(dashboardMe({ ...ADMIN, owner: true })),
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ header: { deploymentId: 'dep_other', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { sessions: 4, spores: 12, members: 1, skill_records: 40, digest_extracts: 2, cortex_instructions: 1, knowledge_release_state: 3 } }, foreignLineage: true, restore: { allowed: true, reason: null }, tables: { skill_records: { rows: 40, inserted: 0, skipped: 'retired' }, digest_extracts: { rows: 2, inserted: 0, skipped: 'retired' }, cortex_instructions: { rows: 1, inserted: 0, skipped: 'retired' }, knowledge_release_state: { rows: 2, inserted: 0, skipped: 'retired' } }, retiredNotice: retiredBackupNotice({ skill_records: 40, digest_extracts: 2, cortex_instructions: 1 }),
        authorityExcluded: { tables: ['members', 'member_credentials'], notice: 'People from the other server are listed here but cannot sign in until the owner re-admits them.' } }),
      '/api/backups/bk_7f3a9c0e21/restore': () => {
        const tables = { sessions: { rows: 4, inserted: 4 }, spores: { rows: 12, inserted: 1, skipped: 'newer rows are kept' } };
        return Response.json({ applied: true, tables, job: restoreJob({ state: 'complete', rowsDone: 16, rowsTotal: 16, completedAt: NOW, outcome: { tables } }) });
      },
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Restore the backup from / });
    expect(within(dialog).getByText("This backup includes older data this version no longer keeps (generated skills, digests, old instructions). It won't be restored.")).toBeTruthy();
    expect(dialog.querySelectorAll('[data-restore-retired]')).toHaveLength(1);
    for (const internal of ['schema step', '#', 'skill records', 'digest extracts', 'cortex instructions']) expect(dialog.textContent).not.toContain(internal);
    expect(dialog.textContent).toContain('It holds sessions 4 · spores 12');
    expect(dialog.querySelector('[data-restore-counts]')?.textContent).toContain('knowledge release state 1');
    expect(dialog.querySelector('[data-restore-counts]')?.textContent).not.toContain('knowledge release state 3');
    expect(dialog.textContent).toContain('comes from another server');
    expect(dialog.textContent).toContain('People from the other server are listed here but cannot sign in until the owner re-admits them.');
    expect(dialog.textContent).not.toContain('their sign-ins, live here');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Turn on the switch');
    expect(posts.map((p) => p.path)).toEqual(['/api/backups/bk_7f3a9c0e21/restore-preview']);
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/api/backups/bk_7f3a9c0e21/restore', body: { allowForeignLineage: true } }));
    expect((await screen.findByText(/^Restored: /)).textContent).toBe('Restored: 5 records added.');
    expect(screen.getByText('spores: newer rows are kept')).toBeTruthy();
    // Closing Backups and opening it again keeps the restore it followed.
    const fold = within(document.querySelector<HTMLElement>('[data-fold="backups"]')!).getAllByRole('button')[0]!;
    fireEvent.click(fold);
    await waitFor(() => expect(screen.queryByText(/^Restored: /)).toBeNull());
    fireEvent.click(fold);
    expect((await screen.findByText(/^Restored: /)).textContent).toBe('Restored: 5 records added.');
  });

  it('keeps Backups and Upkeep, with what automatic recovery reports, when the settings cannot be read', async () => {
    server(routes({
      '/api/settings': () => Response.json({ error: 'unavailable' }, { status: 503 }),
      '/api/status': () => Response.json({ ...STATUS, target: 'cloudflare' }),
      '/api/recovery/exports': () => Response.json({ supported: true, attempt: 5, stage: 'export', form: 'staging', error: null, schedule: { unreadable: 'Automatic backup settings could not be read.' } }),
    }));
    mount(BACKUPS);
    expect((await screen.findByTestId('recovery-latest')).textContent).toBe('Attempt 5 is exporting the database.');
    expect(screen.getByTestId('recovery-unreadable').textContent).toBe('Automatic backup settings could not be read.');
    expect(screen.getByTestId('stored-data-hold')).toBeTruthy();
    expect(document.querySelector('[data-fold="upkeep"]')).not.toBeNull();
    expect(document.querySelector('[data-fold="pace"]')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
  });

  it('lets an admin who is not the owner run upkeep, and shows archived projects with their sessions and last receipt', async () => {
    server(routes());
    mount(UPKEEP);
    expect((await screen.findByRole('button', { name: 'Run housekeeping now' })).hasAttribute('disabled')).toBe(false);
    cleanup();
    server(routes());
    mount('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }));
    const archived = await screen.findByRole('list', { name: 'Archived projects' });
    expect(archived.textContent).toMatch(/3 sessions.*Last sent .*Archived/);
  });

  it('follows a restore the server is still walking until it completes, and names a stopped one with what to do', async () => {
    const preview = () => Response.json({ header: { deploymentId: 'dep_1', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { sessions: 40 } }, foreignLineage: false, restore: { allowed: true, reason: null }, authorityExcluded: null });
    const running = restoreJob({ state: 'running', rowsDone: 10, rowsTotal: 40, outcome: { tables: { sessions: { rows: 40, inserted: 10 } } } });
    let progress = running;
    server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': preview,
      '/api/backups/bk_7f3a9c0e21/restore': () => Response.json({ applied: false, job: running }, { status: 202 }),
      '/api/backups/restores/rs_1': () => Response.json({ job: progress }),
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect((await screen.findByText(/^Restoring: /)).textContent).toBe('Restoring: 25% done, 10 records added so far.');
    expect(screen.getByText(/continues on the server/)).toBeTruthy();
    cleanup();

    progress = restoreJob({ state: 'failed', rowsDone: 20, rowsTotal: 40, completedAt: NOW, outcome: { tables: { sessions: { rows: 40, inserted: 20 } } },
      failure: { code: 'backup_unavailable', message: 'the backup this restore reads is no longer stored; the rows it restored stay' } });
    server(routes({ '/api/backups': () => Response.json({ backups: [BACKUP], restore: progress }) }));
    mount(BACKUPS);
    const stopped = await screen.findByText(/stopped\.$/);
    expect(stopped.textContent).toMatch(/^The restore started .+ stopped\.$/);
    expect(screen.getByText(/no longer stored/).textContent).toContain('restoring the same backup again picks up from them');
  });

  it('continues a restore waiting at session transcripts only when an admin asks, and shows what it added', async () => {
    const waiting = restoreJob({ state: 'running', rowsDone: 30, rowsTotal: 40, outcome: { tables: { sessions: { rows: 2, inserted: 2 } } } });
    const awaiting = { ...waiting, awaitingDocuments: true };
    const complete = restoreJob({ state: 'complete', rowsDone: 40, rowsTotal: 40, completedAt: NOW, outcome: { tables: { sessions: { rows: 2, inserted: 2 }, prompts: { rows: 3, inserted: 3 } } } });
    let job: ReturnType<typeof restoreJob> = awaiting;
    const { posts } = server(routes({
      '/api/backups': () => Response.json({ backups: [BACKUP], restore: job }),
      '/api/backups/restores/rs_1': () => Response.json({ job }),
      // The continue answers mid-walk; the next read finds it finished, and that read is what the page shows.
      '/api/backups/restores/rs_1/continue': () => { job = complete; return Response.json({ applied: false, job: { ...waiting, rowsDone: 35 } }, { status: 202 }); },
    }));
    mount(BACKUPS);
    expect((await screen.findByText(/only while this page continues the restore/)).textContent).toContain('Continue it to finish');
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue restore' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/backups/restores/rs_1/continue']));
    expect((await screen.findByText(/^Restored: /)).textContent).toBe('Restored: 5 records added.');
    expect(screen.queryByRole('button', { name: 'Continue restore' })).toBeNull();
  });

  it('stops a running restore only when an admin asks, and says the rows it restored stay', async () => {
    const running = restoreJob({ state: 'running', rowsDone: 10, rowsTotal: 40, outcome: { tables: { sessions: { rows: 40, inserted: 10 } } } });
    const stopped = restoreJob({ state: 'failed', rowsDone: 10, rowsTotal: 40, completedAt: NOW, outcome: running.outcome,
      failure: { code: 'stopped', message: 'the restore was stopped by its owner; the rows it restored stay, and restoring the same backup again continues it' } });
    let job: ReturnType<typeof restoreJob> = running;
    const { posts } = server(routes({
      '/api/backups': () => Response.json({ backups: [BACKUP], restore: job }),
      '/api/backups/restores/rs_1': () => Response.json({ job }),
      '/api/backups/restores/rs_1/stop': () => { job = stopped; return Response.json({ job: stopped }); },
    }));
    mount(BACKUPS);
    await screen.findByText(/^Restoring: /);
    expect(posts).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Stop restore' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toEqual(['/api/backups/restores/rs_1/stop']));
    expect((await screen.findByText(/stopped\.$/)).textContent).toMatch(/^The restore started .+ stopped\.$/);
    expect(screen.getByText(/stopped by its owner/).textContent).toContain('restoring the same backup again picks up from them');
    expect(screen.queryByRole('button', { name: 'Stop restore' })).toBeNull();
  });

  it('tells the owner how to restore a backup in a format this release no longer restores', async () => {
    server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ error: 'artifact_format_retired', message: 'server sentence', retiredRows: { prompt_batches: 2 }, restoresOn: '2.0.0-alpha.23' }, { status: 409 }),
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const alert = await screen.findByText(/older format this release can’t restore/);
    expect(alert.textContent).toContain('Myco 2.0.0-alpha.23 was the last release that read it');
    expect(alert.textContent).toContain('run myco server restore --target cloudflare --from <recovery copy folder> --secrets-from <recovery secrets file> --account-id <Cloudflare account ID> --source-retired --yes');
    expect(alert.textContent).not.toContain('server sentence');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cancels a restore with nothing sent past the preview', async () => {
    const { posts } = server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ header: { deploymentId: 'dep_1', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { sessions: 4 } }, foreignLineage: false, restore: { allowed: true, reason: null }, authorityExcluded: null }),
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(false);
    expect(dialog.querySelector('[data-restore-authority-excluded]')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts.map((p) => p.path)).toEqual(['/api/backups/bk_7f3a9c0e21/restore-preview']);
  });

  it('keeps authority-bearing backup preview readable but denies a non-owner restore', async () => {
    const { posts } = server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({
        header: { deploymentId: 'dep_1', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { members: 2, sessions: 4 } },
        foreignLineage: false, restore: { allowed: false, reason: 'Only the owner can restore a backup that includes members or access authority.' },
      }),
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Restore the backup from / });
    expect(dialog.textContent).toContain('It holds members 2 · sessions 4');
    expect(within(dialog).getByText('Only the owner can restore a backup that includes members or access authority.')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts.map((p) => p.path)).toEqual(['/api/backups/bk_7f3a9c0e21/restore-preview']);
  });

  it('fails closed when a restore preview has no decision', async () => {
    server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ header: { deploymentId: 'dep_1', schemaVersion: 57, createdAt: BACKUP.created_at, counts: { sessions: 4 } }, foreignLineage: false }),
    }));
    mount(BACKUPS);
    const list = await screen.findByRole('group', { name: 'Backups made here' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Restore the backup from / });
    expect((within(dialog).getByRole('button', { name: 'Restore' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByText('Restore permission is unavailable. Refresh the preview.')).toBeTruthy();
  });


  it('shows no raw id anywhere a reader sees', async () => {
    server(routes());
    mount();
    await verdictFor();
    await screen.findByText(/^Last backup was /);
    expect(rawIdsIn(document.body)).toEqual([]);
  });

  it('shows a member who is not an admin that the page is an admin’s, and asks none of its reads', async () => {
    const { asked } = server(routes({ '/auth/me': () => Response.json(dashboardMe(MEMBER)) }));
    mount();
    expect(await screen.findByTestId('admin-only')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const path of ['/api/attention', '/api/backups', '/api/maintenance', '/api/recovery/exports', '/api/kpis']) {
      expect(asked.some((line) => line.includes(path))).toBe(false);
    }
  });
});

it('describes coded store diagnostics with specific findings and dashboard words for support, measurements and cadence', async () => {
  const prose = 'server prose must stay off the page';
  server(routes({ '/api/maintenance': () => Response.json({ checks: [
    { check: 'optimize', support: { supported: false, reasonCode: 'check_unsupported', reason: prose }, cadence: { state: 'off' }, running: false, latest: null },
    { check: 'integrity', support: { supported: true, label: 'Checks stored records' }, cadence: { state: 'invalid', leaf: 'maintenance.auto_integrity_check', reason: prose }, running: false,
      latest: { runId: 'check1', trigger: 'owner', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null,
        findings: [...Array<string>(10).fill('A stored record is missing.'), 'A file could not be read.'], findingCodes: Array<string>(11).fill('store_problem'), findingsOmitted: 0,
        measurements: [{ name: 'size', state: 'unavailable', reasonCode: 'measurement_unavailable', reason: prose }] } },
  ] }) }));
  mount(UPKEEP);
  const upkeep = await screen.findByTestId('maintenance');
  await waitFor(() => expect(upkeep.textContent).toContain('The store check found a problem.'));
  expect(upkeep.textContent).toContain('Not available on this server.');
  expect(upkeep.textContent).toContain('This measurement is unavailable.');
  expect(upkeep.textContent).not.toContain('A stored record is missing.');
  fireEvent.click(within(upkeep).getByRole('button', { name: 'Findings' }));
  expect(upkeep.textContent).toContain('A stored record is missing. (10 findings)');
  expect(upkeep.textContent).toContain('A file could not be read.');
  expect(upkeep.textContent!.match(/The store check found a problem\./g)).toHaveLength(1);
  expect(upkeep.textContent!.match(/A stored record is missing\./g)).toHaveLength(1);
  expect(upkeep.textContent).toContain('Automatic runs are not scheduled: the saved setting is invalid.');
  expect(document.body.textContent).not.toContain(prose);
});

for (const [code, configured, ready, expected] of [
  ['backup_unsupported', false, false, 'Automatic recovery doesn’t run on this server.'],
  ['backup_off', false, true, 'Automatic recovery is off.'],
  ['backup_not_ready', true, false, 'It can’t run yet: this server is missing something it needs.'],
  ['backup_in_progress', true, true, 'The next one waits for the attempt or backup in progress to end.'],
  ['manual_backup_in_progress', true, true, 'The next one waits for the attempt or backup in progress to end.'],
] as const) {
  it(`describes ${code} without quoting the recovery reason`, async () => {
    const prose = 'server prose must stay off the page';
    server(routes({ '/api/recovery/exports': () => Response.json({ supported: code !== 'backup_unsupported',
      attempt: null, stage: 'idle', form: 'staging', error: null,
      schedule: { supported: code !== 'backup_unsupported', configured, ready, intervalHours: 24, dueAt: null, due: false,
        latest: null, available: { state: 'none' }, idleCode: code, idleBecause: prose },
    }) }));
    mount(BACKUPS);
    await waitFor(() => expect(document.body.textContent).toContain(expected));
    expect(document.body.textContent).not.toContain(prose);
  });
}


describe('dashboard status honesty gates', () => {
  it('finding 3: a failed read of a search model switch, or of the sources search passes over, stays visible under Upkeep, with a retry', async () => {
    for (const endpoint of ['/api/embedding/switch', '/api/embedding/passed-over']) {
      server(routes({ [endpoint]: () => Response.json({ error: 'unavailable' }, { status: 503 }) }));
      mount(UPKEEP);
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Retry' }).length).toBeGreaterThan(0);
      cleanup();
    }
  });
  it('finding 6: a well database survives unread learning and runner facts, and the verdict is not Yes', async () => {
    server(routes({ ...QUIET, '/api/status': () => Response.json({ ...STATUS, workers: { available: false, fleet: null, runsQueued: null }, learning: null, unavailable: ['workers', 'learning'] }) }));
    mount();
    const well = await verdictFor();
    expect(well.querySelector('[data-well-line="database"]')!.getAttribute('data-well-state')).toBe('yes');
    expect(well.querySelector('[data-well-line="learning"]')!.textContent).toContain('Couldn’t read how learning stands just now.');
    expect(well.querySelector('[data-well-line="runners"]')!.textContent).toContain('Couldn’t read the runners just now.');
    expect(well.querySelector('[data-verdict] p')!.textContent).toBe('Needs attention');
  });
  it('names the passed-over sources under Upkeep, with where each is and why', async () => {
    server(routes({ '/api/embedding/passed-over': () => Response.json({ state: 'ready', count: 1, sources: [
      { projectId: 'proj_x', projectName: 'Project X', type: 'plan', title: 'Release checklist', reason: 'its stored text is missing', anyModel: true },
    ] }) }));
    mount(UPKEEP);
    const list = await waitFor(() => { const found = document.querySelector<HTMLElement>('[data-passed-over]'); if (found === null) throw new Error('not yet'); return found; });
    expect(list.textContent).toContain('Search by meaning leaves out 1 source. Search by words still finds it.');
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Plan “Release checklist” in Project X: its stored text is missing']);
  });
});

it('words each installed agent’s state on its machine, for the machine pages', () => {
  const fact = (over: Record<string, unknown>) => ({ id: 'codex', provisioned: true as const, machineId: 'm', machineName: 'Work laptop', state: 'ready' as const, ...over }) as Parameters<typeof harnessHealthWords>[0];
  expect(harnessHealthWords(fact({ id: 'claude-code', state: 'held_elsewhere', toolsDeployment: 'https://myco.whisker.engineering', machineName: 'CKIRBY-MBP' })))
    .toBe("Claude Code's Myco tools on CKIRBY-MBP use myco.whisker.engineering");
  expect(harnessHealthWords(fact({ id: 'claude-code', state: 'held_elsewhere', machineName: 'Personal laptop' }))).toBe("Claude Code's Myco tools on Personal laptop use another Myco");
  expect(harnessHealthWords(fact({ state: 'unwritable', action: 'Allow Myco to write Codex configuration' }))).toBe('Codex on Work laptop: Allow Myco to write Codex configuration');
  expect(harnessHealthWords(fact({ state: 'trust_required', hookRepairAt: NOW - HOUR, ranAt: NOW - 2 * HOUR, action: 'x', machineName: 'Spare laptop' })))
    .toBe("Codex's Myco tools on Spare laptop are set up and waiting for its first run");
});

it('shows a persisted backup retention failure with a retry action under Backups', async () => {
  server(routes({
    '/api/backups': () => Response.json({ backups: [BACKUP], retention: { at: NOW,
      outcome: { state: 'failed', errorClass: 'db' } } }),
  }));
  mount(BACKUPS);
  expect(await screen.findByText(/Backup retention failed/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Create backup' })).toBeTruthy();
});

it('names a changed retention decision under Backups',async()=>{
  server(routes({'/api/backups':()=>Response.json({backups:[BACKUP],retention:{at:NOW,
    outcome:{state:'changed',reason:'retention_changed'}}})}));
  mount(BACKUPS);
  expect(await screen.findByText('Retention changed while pruning; the next backup decides again.')).toBeTruthy();
});

it('shows actual table progress for a running database check', async () => {
  server(routes({ '/api/maintenance': () => Response.json({ checks: [{
    check: 'integrity', support: { supported: true, label: 'Checks stored records' },
    cadence: { state: 'off' }, dueAt: null, running: true,
    latest: { runId: 'check1', trigger: 'owner', state: 'running', startedAt: NOW, finishedAt: null,
      errorClass: null, findings: [], findingsOmitted: 0, measurements: [],
      progress: { completedTables: 16, totalTables: 400 } },
  }] }) }));
  mount(UPKEEP);
  expect(await screen.findByText(/Checked 16 of 400 tables/)).toBeTruthy();
});

it('reports publication counts as building without showing a zero backlog', () => {
  expect(backlogWords({ state: 'building' })).toBe('Transcript backlog counts are being prepared.');
});
