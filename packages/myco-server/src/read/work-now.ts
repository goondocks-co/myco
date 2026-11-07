/**
 * What Myco is doing now: the runs running, the work waiting and why, and what has failed and needs someone. One read
 * answers it for one Project (Myco's work) or every visible Project (Health), and the dashboard's live refresh reads it
 * every tick, so every statement here is a bounded seek: each reads at most the rows its section can show, never a
 * window of history (`tests/myco-server/work-now-read-ceilings.test.ts` holds the ceilings on both stores).
 *
 * **The reasons are the server's.** Every `why` is a sentence this module builds from the fact that decides
 * admission: a queued run's stored holder (`holdSentence`) or the fleet's current wait (`fleetWaits`, the rule the
 * queue and the claim decide by), learning's status line (`learningStatusLine`, which Health already shows), the
 * project's curation daily limit, the code map's schedule, the rolling budget, a backup holding the database, and a
 * failed run's own refusal text. The dashboard prints them; it never decides why something waits.
 *
 * **Needs you clears itself.** A failure is listed while the latest finished runs of its task in its Project failed;
 * the first later success removes it. A failing curation group is listed while it stays open and is gone once it is
 * decided. A runner that cannot sign in is listed while its own readiness says so.
 *
 * A section whose read fails is named in `unavailable` and the others still answer.
 */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { QUEUE_REASON_WORDS } from '@goondocks/myco-shared/runner-fleet';
import { holdSentence, visibleRunHolder } from '@goondocks/myco-shared/run-holds';
import { stepWords } from '@goondocks/myco-shared/step-words';
import { callWords } from '@goondocks/myco-shared/call-words';
import type { StepKind } from '@goondocks/myco-shared/worker-steps';
import type { Marks } from '@goondocks/myco-shared/live-marks';
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { CURATION_TASK, EXTRACTION_TASK, SEEDING_TASK, CARD_TASK, TASK_WORDS } from '../core/task-catalogue.js';
import { RUN_TOOL_EVENT } from '../core/runs.js';
import { FAILED_CALL_INDEX, FAILED_CALL_SQL } from '../db/schema-v701.js';
import { contextValue, FAILURE_REASON_KEY } from '../db/run-context.js';
import { readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { applyFleetSignInAvailability, fleetSelectionContext, fleetWaits } from './fleet.js';
import { learningStatusLine, readLearningStatus } from '../core/learning-sessions.js';
import { readBudgetHolds } from './budget.js';
import { BUDGET_WINDOW_MS } from '../core/budget-policy.js';
import { CURATION_DAILY_LIMIT_MAX, curationDailyLimitSql, enabledCapabilities, type ProjectCapability } from '../core/settings.js';
import { CURATION_MAX_FAILURES } from '../core/spore-curation.js';
import { capabilityOf } from '../core/worker-selection.js';
import { PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/schedule-rules.js';
import { TASK_SCHEDULE } from '../core/jobs.js';
import { ADVANCING_STAGES, type RecoveryProducerStatus } from '../core/recovery-producer.js';
import { within } from '../core/recovery-inventory.js';
import { OUTCOME_LOOKBACK_MS } from '../core/attention-state.js';

/** The most running runs one answer lists. A runner holds one run at a time, so this is past any fleet's width. */
export const NOW_RUNNING_MAX = 20;
/** The most queued runs one answer reads; the waiting groups are counted over these. */
export const NOW_QUEUED_MAX = 200;
/** The most Projects whose per-Project work (curation, the code map, failures) one Deployment-wide answer reads. */
export const NOW_PROJECTS_MAX = 25;
/** How many of a Project's open curation groups, soonest due first, are read for the ones that failed. */
export const NOW_OPEN_GROUPS = 50;
/** The most failing curation groups one Project lists. */
export const NOW_FAILING_GROUPS = 3;
/** How many of the Deployment's latest finished runs are read to put the Projects with a recent failure first. */
export const NOW_RECENT_FINISHED = 100;
/** How many of a task's latest runs decide whether its failure still stands. */
export const NOW_RECENT_RUNS = 5;
/** How long a producer is given to say whether a backup is copying the database. */
const BACKUP_STATUS_MS = 2_000;

/** An open curation group that failed and will be tried again, in its Project. */
interface FailingGroup { projectId: string; group: Record<string, unknown> }

/** A curation group's decisions that settle it: a failure of the run that worked on it no longer needs anyone. */
const SETTLED_DECISIONS: readonly string[] = ['keep', 'resolved', 'changed'];

/** The tasks whose failure needs someone: what Myco learns, maps, seeds and curates. */
export const NOW_WATCHED_TASKS: readonly string[] = [EXTRACTION_TASK, MAP_TASK, CURATION_TASK, SEEDING_TASK];

export type WorkNowSection = 'running' | 'waiting' | 'needsYou';

/** A run running now, with the latest thing it did. */
export interface NowRunning {
  runId: string;
  projectId: string;
  task: string;
  /** The task in the reader's words. */
  what: string;
  /** The runner holding it, by its own name; null where none is named. */
  machine: string | null;
  harness: string | null;
  model: string | null;
  startedAt: number | null;
  /** Its latest step or call to Myco, in the reader's words; null before it has done anything Myco saw. */
  step: { words: string; at: number } | null;
}

/** Work that waits, and the server's reason. */
export interface NowWaiting {
  key: string;
  /** The Project it waits in, or null for what waits Deployment-wide. */
  projectId: string | null;
  what: string;
  /** How many queued runs or due items it stands for, where it is a count. */
  count: number | null;
  why: string;
  /** When it began to wait, where known. */
  since: number | null;
  /** When it is next due, where a schedule says. */
  nextAt: number | null;
}

/** A failure or a stuck item, with the server's own reason and the run to open. */
export interface NowNeed {
  key: string;
  projectId: string | null;
  what: string;
  why: string;
  at: number;
  /** The run its reason comes from; null where none does. */
  runId: string | null;
  /** When Myco tries again by itself, where it will. */
  retryAt: number | null;
}

export interface WorkNowAnswer {
  observedAt: number;
  scope: 'project' | 'deployment';
  running: NowRunning[];
  waiting: NowWaiting[];
  needsYou: NowNeed[];
  /**
   * What moved between answers: `runs` changes when a run starts, finishes, queues or fails; `sessions` when
   * any session receives capture; `knowledge` when a spore is written, edited, retired or deleted (the per-Project
   * spore revision the spore triggers keep) or a plan changes; `recovery` when a backup attempt starts, advances or
   * settles; `fleet` when a runner comes, goes, pauses or takes a run. The dashboard re-reads a page's other reads only
   * when the mark they follow moves.
   */
  marks: Marks;
  /**
   * How many Projects this answer read per-Project work for, of how many it covers. A Deployment-wide answer reads
   * Projects with something running, queued or recently failed first, then the rest up to `NOW_PROJECTS_MAX`; when
   * `read` is below `total` the page says so and offers each Project's own page.
   */
  projects: { read: number; total: number };
  unavailable: WorkNowSection[];
}

/** One Project, or every Project the dashboard lists. */
export type WorkNowScope = { projectId: string } | { all: true };

const taskName = (task: string | null): string => (task !== null && task in TASK_WORDS ? TASK_WORDS[task as keyof typeof TASK_WORDS].name : task ?? 'A task');
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Projects the answer reads per-Project work for: the one named, or up to `NOW_PROJECTS_MAX` visible ones, those
 * with work in motion (`active`) or a failed watched run among the Deployment's latest finished runs first.
 */
async function projectsOf(db: RelationalStore, scope: WorkNowScope, active: readonly string[]): Promise<{ read: string[]; total: number }> {
  if ('projectId' in scope) return { read: [scope.projectId], total: 1 };
  const [visible, failed] = await db.batch([
    db.prepare('SELECT project_id FROM projects WHERE archived_at IS NULL ORDER BY project_id'),
    db.prepare(`SELECT project_id, task, status FROM agent_runs INDEXED BY idx_agent_runs_retention
        WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0
        ORDER BY COALESCE(completed_at, started_at) DESC, id DESC LIMIT ?`).bind(NOW_RECENT_FINISHED),
  ]);
  const all = (visible!.results as Array<{ project_id: string }>).map((row) => row.project_id);
  const known = new Set(all);
  const recentFailures = (failed!.results as Array<{ project_id: string; task: string | null; status: string }>)
    .filter((row) => row.status === 'failed' && row.task !== null && NOW_WATCHED_TASKS.includes(row.task)).map((row) => row.project_id);
  const first = [...active, ...recentFailures].filter((id) => known.has(id));
  const read = [...new Set([...first, ...all])].slice(0, NOW_PROJECTS_MAX);
  return { read, total: all.length };
}

const inScope = (scope: WorkNowScope, alias: string): { sql: string; params: string[] } => 'projectId' in scope
  ? { sql: `${alias}.project_id = ?`, params: [scope.projectId] }
  : { sql: `EXISTS (SELECT 1 FROM projects p WHERE p.project_id = ${alias}.project_id AND p.archived_at IS NULL)`, params: [] };

/** The latest thing a run did that Myco saw: its worker's latest step, or its latest call to Myco, whichever is later. */
function latestStep(step: Record<string, unknown> | null, call: Record<string, unknown> | null, harness: string | null): NowRunning['step'] {
  const fromStep = step === null ? null : (() => {
    const words = stepWords({ kind: String(step.kind) as StepKind, tool: String(step.tool), target: str(step.target) }, harness);
    return { words: words.target === null ? words.lead : `${words.lead} ${words.target}`, at: Number(step.started_at) };
  })();
  const fromCall = call === null ? null : (() => {
    let op: string | null = null;
    try { const payload = JSON.parse(String(call.payload ?? 'null')) as { op?: unknown } | null; op = typeof payload?.op === 'string' ? payload.op : null; } catch { /* no op recorded */ }
    return { words: callWords(String(call.tool_name), op), at: Number(call.recorded_at) };
  })();
  if (fromStep === null) return fromCall;
  if (fromCall === null) return fromStep;
  return fromCall.at > fromStep.at ? fromCall : fromStep;
}

async function readRunning(db: RelationalStore, scope: WorkNowScope): Promise<NowRunning[]> {
  const filter = inScope(scope, 'r');
  const { results } = await db.prepare(`SELECT r.project_id, r.id, r.task, r.harness, r.model, r.started_at, n.name AS runner
      FROM agent_runs r INDEXED BY idx_agent_runs_claimable LEFT JOIN runners n ON n.id = r.leased_runner_id
     WHERE r.status = 'running' AND ${filter.sql} ORDER BY r.queued_at LIMIT ?`)
    .bind(...filter.params, NOW_RUNNING_MAX).all<Record<string, unknown>>();
  if (results.length === 0) return [];
  const statements = results.flatMap((row) => [
    db.prepare(`SELECT json_extract(profile_json, '$.harness') AS harness, json_extract(profile_json, '$.profile.model') AS model
        FROM agent_run_attempts WHERE project_id = ? AND run_id = ? ORDER BY claimed_at DESC LIMIT 1`).bind(row.project_id, row.id),
    db.prepare(`SELECT s.kind, s.tool, s.target, s.started_at FROM agent_run_steps s
        WHERE s.project_id = ? AND s.run_id = ? AND s.attempt_id = (SELECT attempt_id FROM agent_run_attempts
          WHERE project_id = ? AND run_id = ? ORDER BY claimed_at DESC LIMIT 1) ORDER BY s.seq DESC LIMIT 1`)
      .bind(row.project_id, row.id, row.project_id, row.id),
    db.prepare(`SELECT tool_name, payload, recorded_at FROM agent_run_events
        WHERE project_id = ? AND run_id = ? AND event_type = ? ORDER BY recorded_at DESC LIMIT 1`).bind(row.project_id, row.id, RUN_TOOL_EVENT),
  ]);
  const answers = await db.batch(statements);
  return results.map((row, i) => {
    const first = <T>(n: number) => (answers[i * 3 + n]!.results[0] as T | undefined) ?? null;
    const attempt = first<Record<string, unknown>>(0);
    const harness = str(row.harness) ?? str(attempt?.harness);
    return {
      runId: String(row.id), projectId: String(row.project_id), task: String(row.task ?? ''), what: taskName(str(row.task)),
      machine: str(row.runner), harness, model: str(row.model) ?? str(attempt?.model), startedAt: num(row.started_at),
      step: latestStep(first(1), first(2), harness),
    };
  });
}

/** Queued runs grouped by Project and task, each with its stored holder's sentence or the fleet's current wait. */
async function readQueued(env: ServerEnv, scope: WorkNowScope, fleet: readonly WorkerFleetRow[], now: number, includeSignIn: boolean): Promise<NowWaiting[]> {
  const tasks = Object.keys(TASK_WORDS);
  const { results } = 'projectId' in scope
    ? await env.db.prepare(`SELECT project_id, task, held_by, queued_at FROM agent_runs INDEXED BY idx_agent_runs_task
        WHERE project_id = ? AND task IN (${tasks.map(() => '?').join(', ')}) AND status = 'queued' LIMIT ?`)
      .bind(scope.projectId, ...tasks, NOW_QUEUED_MAX).all<Record<string, unknown>>()
    : await env.db.prepare(`SELECT r.project_id, r.task, r.held_by, r.queued_at FROM agent_runs r INDEXED BY idx_fleet_queue
        WHERE r.status = 'queued' AND ${inScope(scope, 'r').sql} LIMIT ?`).bind(NOW_QUEUED_MAX).all<Record<string, unknown>>();
  const groups = new Map<string, { projectId: string; task: string | null; held: string | null; count: number; since: number | null }>();
  for (const row of results) {
    const held = visibleRunHolder(str(row.held_by), includeSignIn);
    const key = `${String(row.project_id)}\u0000${String(row.task)}\u0000${held ?? ''}`;
    const group = groups.get(key) ?? { projectId: String(row.project_id), task: str(row.task), held, count: 0, since: null };
    group.count += 1;
    const at = num(row.queued_at);
    if (at !== null) group.since = group.since === null ? at : Math.min(group.since, at);
    groups.set(key, group);
  }
  const waits = await fleetWaits(env, [...groups.values()].filter((g) => holdSentence(g.held) === null).map((g) => g.task), now, includeSignIn, fleet);
  return [...groups.entries()].map(([key, group]) => ({
    key: `queued:${key}`, projectId: group.projectId, what: taskName(group.task), count: group.count,
    why: holdSentence(group.held) ?? QUEUE_REASON_WORDS[waits.get(group.task)?.reason ?? 'unavailable'],
    since: group.since, nextAt: null,
  }));
}

/** Per-Project schedules: an open curation group not yet running, and the code map's next refresh. */
async function readScheduled(env: ServerEnv, projects: readonly string[], onePage: boolean, live: ReadonlySet<string>, now: number): Promise<{ waiting: NowWaiting[]; failingGroups: FailingGroup[] }> {
  const failingGroups: FailingGroup[] = [];
  if (projects.length === 0) return { waiting: [], failingGroups };
  const mapCapability = capabilityOf(MAP_TASK);
  const capabilities: ProjectCapability[] = ['spore_curation', ...(mapCapability === null ? [] : [mapCapability])];
  const on = enabledCapabilities(env.db, capabilities, projects.length === 1 ? projects[0] : undefined);
  const [enabled, leaves] = await Promise.all([on.statement.all<Record<string, unknown>>(), scheduleLeaves(env)]);
  const has = new Set(on.read(enabled.results).filter((row) => projects.includes(row.projectId)).map((row) => `${row.projectId}\u0000${row.capability}`));
  const curating = projects.filter((projectId) => has.has(`${projectId}\u0000spore_curation`));
  const mapping = leaves.enabled && leaves.mapRefresh.enabled ? projects.filter((projectId) => mapCapability === null || has.has(`${projectId}\u0000${mapCapability}`)) : [];
  const statements = [
    ...curating.flatMap((projectId) => [
      env.db.prepare(`SELECT cluster_key, due_at FROM spore_curation_work INDEXED BY idx_curation_due
          WHERE project_id = ? AND due_at IS NOT NULL AND failures = 0 ORDER BY due_at LIMIT 1`).bind(projectId),
      env.db.prepare(`SELECT cluster_key, due_at, failures, run_id, write_refusal FROM (SELECT * FROM spore_curation_work INDEXED BY idx_curation_due
          WHERE project_id = ? AND due_at IS NOT NULL ORDER BY due_at LIMIT ${NOW_OPEN_GROUPS}) WHERE failures > 0 AND failures < ? LIMIT ${NOW_FAILING_GROUPS}`)
        .bind(projectId, CURATION_MAX_FAILURES),
      env.db.prepare(`SELECT COUNT(*) AS started, MIN(first_started_at) AS oldest, ${curationDailyLimitSql('?')} AS limit_value FROM (SELECT first_started_at
          FROM spore_curation_work INDEXED BY idx_curation_first_started WHERE project_id = ? AND first_started_at IS NOT NULL AND first_started_at > ?
          LIMIT ${CURATION_DAILY_LIMIT_MAX})`).bind(projectId, projectId, now - BUDGET_WINDOW_MS),
    ]),
    ...mapping.map((projectId) => env.db.prepare(`SELECT COALESCE(queued_at, started_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_entry
        WHERE project_id = ? AND task = ? AND status != 'skipped' ORDER BY COALESCE(queued_at, started_at) DESC LIMIT 1`).bind(projectId, MAP_TASK)),
  ];
  const answers = statements.length === 0 ? [] : await env.db.batch(statements);
  const waiting: NowWaiting[] = [];
  curating.forEach((projectId, i) => {
    const next = (answers[i * 3]!.results[0] as Record<string, unknown> | undefined) ?? null;
    for (const group of answers[i * 3 + 1]!.results as Record<string, unknown>[]) failingGroups.push({ projectId, group });
    const day = answers[i * 3 + 2]!.results[0] as Record<string, unknown>;
    if (next === null || live.has(`${projectId}\u0000${CURATION_TASK}`)) return;
    const started = Number(day.started);
    const limit = Number(day.limit_value);
    const dueAt = Number(next.due_at);
    const oldest = num(day.oldest);
    const why = started >= limit
      ? `Paused: ${started} of ${limit} new curation groups started in the last 24 hours. The next starts as the earliest leaves that window; a group that failed retries meanwhile.`
      : dueAt > now ? 'Its next group of overlapping spores comes due at the time shown.'
        : 'A group of overlapping spores is due; it starts when the server next checks, inside the daily budget.';
    waiting.push({ key: `curation:${projectId}`, projectId, what: 'Curation', count: null, why, since: null,
      nextAt: started >= limit && oldest !== null ? oldest + BUDGET_WINDOW_MS : dueAt > now ? dueAt : null });
  });
  const mapSchedule = scheduleFor(MAP_TASK, TASK_SCHEDULE[MAP_TASK]!, leaves.overrides);
  const condition = mapSchedule.preCondition === undefined ? undefined : PRE_CONDITIONS[mapSchedule.preCondition];
  const intervalMs = leaves.mapRefresh.intervalSeconds * 1000;
  const every = `It refreshes every ${plural(Math.max(1, Math.round(intervalMs / 3_600_000)), 'hour')}`;
  const ready = await Promise.all(mapping.map((projectId) => condition === undefined ? true : condition({ db: env.db, projectId, now })));
  mapping.forEach((projectId, i) => {
    if (live.has(`${projectId}\u0000${MAP_TASK}`)) return;
    const last = num((answers[curating.length * 3 + i]!.results[0] as Record<string, unknown> | undefined)?.at);
    if (!ready[i]) {
      // A quiet project's map waits on nothing anyone can act on; only its own page says so.
      if (onePage) waiting.push({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, since: last, nextAt: null,
        why: `${every}, and only after new session material arrives. None has arrived since the last refresh.` });
      return;
    }
    const dueAt = last === null ? now : last + intervalMs;
    waiting.push({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, since: last, nextAt: dueAt > now ? dueAt : null,
      why: dueAt > now ? `${every}. New session material has arrived since the last refresh.` : 'Due now. It starts when the server next checks.' });
  });
  return { waiting, failingGroups };
}

/** Deployment-wide holds: the rolling budget spent, learning's backlog, and a backup that holds the database. */
async function readHolds(env: ServerEnv, scope: WorkNowScope, fleet: readonly WorkerFleetRow[], live: ReadonlySet<string>, now: number, includeSignIn: boolean,
  recovery: RecoveryProducerStatus | null): Promise<NowWaiting[]> {
  const waiting: NowWaiting[] = [];
  const holds = await readBudgetHolds(env.db);
  const held = holds.heldHeads ?? [];
  const tooSmall = held.find((head) => head.reason === 'budget_too_small');
  if (held.length > 0) {
    waiting.push({ key: 'budget', projectId: null, what: 'Automatic work', count: null, since: null, nextAt: null,
      why: tooSmall !== undefined && tooSmall.requiredUsd !== null
        ? `The next ${taskName(tooSmall.task).toLowerCase()} run needs about $${tooSmall.requiredUsd.toFixed(2)}, more than the whole daily budget of $${holds.dailyUsd.toFixed(2)}. Raise the daily budget in Settings.`
        : 'Paused: the rolling 24-hour budget has no room for the next automatic run. It resumes as earlier spending leaves the window.' });
  }
  const projectId = 'projectId' in scope ? scope.projectId : null;
  const learning = await readLearningStatus(env.db, now, projectId === null ? undefined : { projectId });
  const learningLive = [...live].some((key) => key.endsWith(`\u0000${EXTRACTION_TASK}`) || key.endsWith(`\u0000${CARD_TASK}`));
  if (!learningLive && (learning.dueSessions > 0 || learning.turnsAwaitingCards > 0)) {
    const task = learning.turnsAwaitingCards > 0 ? CARD_TASK : EXTRACTION_TASK;
    const waits = await fleetWaits(env, [task], now, includeSignIn, fleet);
    const reason = [...waits.values()][0]?.reason;
    const line = learningStatusLine(learning, null, now, reason === 'not_signed_in' || reason === 'credential_unavailable',
      held.some((head) => head.task === task));
    waiting.push({ key: 'learning', projectId, what: 'Learning from sessions', count: learning.dueSessions, why: line[0]!.toUpperCase() + line.slice(1), since: null, nextAt: null });
  }
  if (recovery !== null && (ADVANCING_STAGES as readonly string[]).includes(recovery.stage)) {
    waiting.push({ key: 'backup', projectId: null, what: 'Backup', count: null, since: recovery.startedAt, nextAt: null,
      why: 'A backup is copying the database. Work that reads it waits until the copy finishes.' });
  }
  return waiting;
}

/** The latest failed call's own refusal text for each run, else the run's stored reason. */
async function failureReasons(db: RelationalStore, runs: ReadonlyArray<{ projectId: string; runId: string }>): Promise<Map<string, string>> {
  const reasons = new Map<string, string>();
  if (runs.length === 0) return reasons;
  const answers = await db.batch(runs.flatMap(({ projectId, runId }) => [
    db.prepare(`SELECT payload FROM agent_run_events INDEXED BY ${FAILED_CALL_INDEX} WHERE project_id = ? AND run_id = ?
        AND ${FAILED_CALL_SQL} ORDER BY recorded_at DESC LIMIT 1`).bind(projectId, runId),
    db.prepare(`SELECT error, ${contextValue(FAILURE_REASON_KEY)} AS reason FROM agent_runs WHERE project_id = ? AND id = ?`).bind(projectId, runId),
  ]));
  runs.forEach(({ projectId, runId }, i) => {
    const call = answers[i * 2]!.results[0] as { payload?: unknown } | undefined;
    let message: string | null = null;
    try {
      const failure = (JSON.parse(String(call?.payload ?? 'null')) as { failure?: { message?: unknown } } | null)?.failure;
      if (typeof failure?.message === 'string' && failure.message.trim() !== '') message = failure.message.trim();
    } catch { /* no refusal recorded */ }
    const run = answers[i * 2 + 1]!.results[0] as { error?: unknown; reason?: unknown } | undefined;
    const stored = [run?.reason, run?.error].find((value): value is string => typeof value === 'string' && value.trim() !== '');
    reasons.set(`${projectId}\u0000${runId}`, message ?? stored ?? 'Myco didn’t record why.');
  });
  return reasons;
}

async function readNeeds(env: ServerEnv, projects: readonly string[], failingGroups: readonly FailingGroup[], fleet: readonly WorkerFleetRow[], now: number): Promise<NowNeed[]> {
  const pairs = projects.flatMap((projectId) => NOW_WATCHED_TASKS.map((task) => ({ projectId, task })));
  const answers = pairs.length === 0 ? [] : await env.db.batch(pairs.map(({ projectId, task }) => env.db.prepare(
    `SELECT id, status, COALESCE(completed_at, started_at, queued_at) AS at FROM agent_runs INDEXED BY idx_agent_runs_entry
      WHERE project_id = ? AND task = ? AND status != 'skipped' ORDER BY COALESCE(queued_at, started_at) DESC LIMIT ?`,
  ).bind(projectId, task, NOW_RECENT_RUNS)));
  const failing: Array<{ projectId: string; task: string; runId: string; failures: number; at: number }> = [];
  pairs.forEach(({ projectId, task }, i) => {
    if (task === CURATION_TASK && failingGroups.some((failing) => failing.projectId === projectId)) return;
    const finished = (answers[i]!.results as Record<string, unknown>[]).filter((row) => row.status === 'completed' || row.status === 'failed');
    const failures = finished.findIndex((row) => row.status !== 'failed');
    const count = failures === -1 ? finished.length : failures;
    const latest = finished[0];
    if (count === 0 || latest === undefined || Number(latest.at) < now - OUTCOME_LOOKBACK_MS) return;
    failing.push({ projectId, task, runId: String(latest.id), failures: count, at: Number(latest.at) });
  });
  const curation = failing.filter((f) => f.task === CURATION_TASK);
  const dispositions = curation.length === 0 ? [] : await env.db.batch(curation.map((f) => env.db.prepare(
    `SELECT decision, reason FROM spore_curation_work INDEXED BY idx_curation_evidence WHERE project_id = ? AND run_id = ? LIMIT 1`).bind(f.projectId, f.runId)));
  const stopped = new Map<string, string>();
  curation.forEach((f, i) => {
    const group = dispositions[i]!.results[0] as { decision?: unknown; reason?: unknown } | undefined;
    if (group?.decision === undefined || group.decision === null) return;
    if (SETTLED_DECISIONS.includes(String(group.decision))) failing.splice(failing.indexOf(f), 1);
    else stopped.set(f.runId, String(group.reason ?? ''));
  });
  const groups = failingGroups.filter(({ group }) => group.run_id !== null);
  const reasons = await failureReasons(env.db, [...failing, ...groups.map(({ projectId, group }) => ({ projectId, runId: String(group.run_id) }))]);
  const refusal = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    try { const error = (JSON.parse(raw) as { error?: unknown }).error; return typeof error === 'string' && error.trim() !== '' ? error.trim() : null; } catch { return null; }
  };
  const reason = (projectId: string, runId: string) => reasons.get(`${projectId}\u0000${runId}`) ?? 'Myco didn’t record why.';
  const atLeast = (n: number) => (n >= NOW_RECENT_RUNS ? `at least ${n} times` : n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  return [
    ...failingGroups.map(({ projectId, group }): NowNeed => ({
      key: `curation-group:${projectId}:${String(group.cluster_key)}`, projectId,
      what: `A curation group failed ${atLeast(Number(group.failures))}`,
      why: refusal(group.write_refusal) ?? (group.run_id === null ? 'Myco didn’t record why.' : reason(projectId, String(group.run_id))),
      at: now, runId: str(group.run_id), retryAt: num(group.due_at),
    })),
    ...failing.map((f): NowNeed => ({
      key: `failed:${f.projectId}:${f.task}`, projectId: f.projectId,
      what: stopped.has(f.runId) ? 'Curation stopped on a group without a decision'
        : `${taskName(f.task)} failed ${f.failures === 1 ? 'on its latest run' : `${atLeast(f.failures)} in a row`}`,
      why: stopped.get(f.runId) || reason(f.projectId, f.runId), at: f.at, runId: f.runId, retryAt: null,
    })),
    ...fleet.flatMap((row): NowNeed[] => {
      const runner = row.runnerDetails;
      const code = runner?.readiness.code;
      if (runner === undefined || row.runner?.state !== 'enabled' || (code !== 'not_signed_in' && code !== 'credential_unavailable')) return [];
      return [{ key: `sign-in:${row.runner.id}`, projectId: null, what: `${row.runner.name} can’t sign in to a coding agent`,
        why: runner.readiness.reason, at: runner.readiness.observedAt ?? now, runId: null, retryAt: null }];
    }),
  ];
}

/** Every section, each read on its own so one that fails is named and the rest still answer. */
export async function readWorkNow(env: ServerEnv, scope: WorkNowScope, now: number, includeSignIn: boolean): Promise<WorkNowAnswer> {
  const unavailable: WorkNowSection[] = [];
  const settle = async <T>(section: WorkNowSection, read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch { if (!unavailable.includes(section)) unavailable.push(section); return fallback; }
  };
  const producer = env.recovery;
  const [fleet, marks, running, recovery] = await Promise.all([
    settle('waiting', async () => {
      const rows = await readWorkerFleet(env.db, now, includeSignIn);
      if (includeSignIn) await applyFleetSignInAvailability(rows, now, fleetSelectionContext(env, true).available);
      return rows;
    }, [] as WorkerFleetRow[]),
    env.db.batch([
      env.db.prepare('SELECT MAX(started_at) AS at FROM agent_runs'),
      env.db.prepare('SELECT MAX(last_live_received_at) AS at FROM sessions WHERE last_live_received_at IS NOT NULL'),
      env.db.prepare('SELECT SUM(revision) AS at FROM spore_curation_changes'),
      env.db.prepare('SELECT MAX(updated_at) AS at FROM plans INDEXED BY idx_plans_updated_deployment'),
    ]).then((answers) => answers.map((answer) => String((answer.results[0] as { at?: unknown } | undefined)?.at ?? '')),
      // Marks that cannot be read move on every answer, so the reads that follow them refresh rather than freeze.
      () => Array.from({ length: 4 }, () => `unread:${now}`)),
    settle('running', () => readRunning(env.db, scope), [] as NowRunning[]),
    producer === undefined ? null : within(() => producer.status(), BACKUP_STATUS_MS, Date.now).catch(() => null),
  ]);
  const queued = await settle('waiting', () => readQueued(env, scope, fleet, now, includeSignIn), [] as NowWaiting[]);
  const live = new Set([...running.map((r) => `${r.projectId}\u0000${r.task}`), ...queued.map((q) => q.key.slice('queued:'.length).split('\u0000').slice(0, 2).join('\u0000'))]);
  const active = [...running.map((r) => r.projectId), ...queued.flatMap((q) => (q.projectId === null ? [] : [q.projectId]))];
  const projects = await settle('needsYou', () => projectsOf(env.db, scope, active), { read: [] as string[], total: 0 });
  const [scheduled, holds] = await Promise.all([
    settle('waiting', () => readScheduled(env, projects.read, 'projectId' in scope, live, now), { waiting: [], failingGroups: [] as FailingGroup[] }),
    settle('waiting', () => readHolds(env, scope, fleet, live, now, includeSignIn, recovery), [] as NowWaiting[]),
  ]);
  const needsYou = await settle('needsYou', () => readNeeds(env, projects.read, scheduled.failingGroups, fleet, now), [] as NowNeed[]);
  const waiting = [...holds, ...queued, ...scheduled.waiting];
  return {
    observedAt: now, scope: 'projectId' in scope ? 'project' : 'deployment', running, waiting, needsYou, unavailable,
    projects: { read: projects.read.length, total: projects.total },
    marks: {
      runs: [marks[0], ...running.map((r) => r.runId), ...waiting.map((w) => `${w.key}=${w.count ?? ''}`), ...needsYou.map((n) => n.key)].join('|'),
      sessions: marks[1]!,
      knowledge: `${marks[2]}|${marks[3]}`,
      recovery: recovery === null ? '' : `${recovery.attempt ?? ''}:${recovery.stage}:${recovery.staged?.parts ?? ''}:${recovery.staged?.downloadedBytes ?? ''}`,
      fleet: fleet.map((row) => `${row.runner?.id ?? row.credentialId}:${row.runnerDetails?.display ?? (row.recent ? 'recent' : 'quiet')}:${row.busy?.runId ?? ''}`).join('|'),
    },
  };
}
