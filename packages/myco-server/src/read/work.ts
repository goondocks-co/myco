import { parseRepositoryFailure } from '@goondocks/myco-shared/run-text';
import { type RepositoryFailure } from '@goondocks/myco-shared/repository';
import { heldPartition } from '../core/embedding/policy.js';
import { requestedProfile, type ExecutionProfile } from '@goondocks/myco-shared/execution-profile';
import { type RunResult } from './run-outcome.js';
import { runAccounting } from './accounting.js';
import type { RecordedIdentity, CostProvenance } from '@goondocks/myco-shared/worker-usage';
/**
 * Myco's work: what the Deployment's own runs produced over a window, read across Projects.
 *
 * A supported UTC window (one UTC day, or seven ending on the last) answers full-window counts from the maintained
 * rollups beside its first page of run evidence. Any other range has no totals: it answers the paged evidence only.
 *
 * **The outcome, not the status.** A run is counted by what it left in the store: the spores it wrote (`spores.author`
 * names the run), the session title it landed and the map it wrote (each a write the run recorded). A learning run
 * marked failed that saved spores reports its spores, with the failure beside them as a note, and a run that completed
 * having written nothing remains in the counts and is omitted from the timeline.
 *
 * **Upkeep is summarised, never listed.** The search index's own runs are frequent enough that a list of them would
 * drown every other run, so the read answers when the index last succeeded, how many of its runs failed in the window,
 * and how many have failed after that success. A failure a later success followed is a retry, not a failure.
 */
import { runErrorCode, type RunErrorCode } from '../core/reader-codes.js';
import { auditRows, awaitingRow, currentMaps, failingRows, holdRows, supportedUtcWindow, upkeepRows, workHistoryReady, workSummary, workTimeline, WORK_TIMELINE_PAGE, DAY_MS, type TimelineCursor, type UtcWindow } from '../db/runs/history.js';
import type { RelationalStore } from '../core/adapters.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { EXTRACTION_TASK, SEEDING_TASK, TITLING_TASK } from '../core/task-catalogue.js';
import { EMBEDDING_TASK } from '../core/embedding/task.js';
import type { ProjectSet } from './scope.js';

/** What an outcome task produces, in the words the dashboard groups work by. */
export type OutcomeKind = 'learn' | 'title' | 'map' | 'seed';

/** Each outcome task and the kind of work it is. */
const OUTCOME_KINDS: Readonly<Record<string, OutcomeKind>> = {
  [EXTRACTION_TASK]: 'learn',
  [TITLING_TASK]: 'title',
  [MAP_TASK]: 'map',
  [SEEDING_TASK]: 'seed',
};

/** The most runs one answer lists; the counts cover every run in the window whatever this cuts. */
export const MAX_WORK_RUNS = WORK_TIMELINE_PAGE;
/** The longest window one read covers, a little over the retention a run is kept for by default. */
export const MAX_WORK_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/** The UTC days a read covers when it names none: the last seven, ending with today. */
export const DEFAULT_WORK_WINDOW_DAYS = 7;

/** A least and greatest value over the runs that reported one; null where none did. */
type Range = readonly [number, number] | null;

/** One Project's work of one kind over the window. */
export interface WorkOutcome {
  projectId: string;
  kind: OutcomeKind;
  task: string;
  /** Runs by status, every run in the window counted once. */
  runs: Record<string, number>;
  /** What the runs left: spores written, sessions those spores came from or that a title landed on, and maps written. */
  outcome: { spores: number; sessions: number; maps: number };
  /** Failed runs that still produced something; their output is counted above and the failure is a note. */
  failedWithOutput: number;
  /** Failed runs that produced nothing. */
  failed: number;
  /** Failed runs without output in this window, and whether a later run of this Project and task has resolved them. */
  failure: { runs: number; latestAt: number; latestRunId: string; unresolved: boolean } | null;
  /** The latest instant a run of this kind is shown at (`at` on a listed run). */
  latestAt: number | null;
  /** Tokens and cost as the runs themselves reported them, and how many runs that started and finished reported no cost. */
  tokens: number;
  costUsd: number;
  runsWithoutCost: number;
  /** What one completed run spent: tokens, cost and wall time, least to greatest. */
  spend: { tokens: Range; costUsd: Range; durationMs: Range };
}

/** A Project's current code map. */
interface WorkMap { projectId: string; branch: string; commit: string; generatedAt: number; sourceRunId: string }

/** A run that published output or failed, listed in the timeline. */
export interface WorkRun {
  requested: ExecutionProfile | null;
  queuedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  harness: string | null;
  model: string | null;
  provider: string | null;
  identity: RecordedIdentity;
  costProvenance: CostProvenance | null;
  id: string;
  projectId: string;
  task: string;
  kind: OutcomeKind;
  status: string;
  result: RunResult;
  /** When the run ended, else when it queued, else when it started: the instant the window is read by. */
  at: number | null;
  outcome: { spores: number; sessions: number; maps: number };
  /** The session a title run titled; null for every other run. */
  sessionId: string | null;
  /** The terminal failure classifier and stored reason, separate from the agent's report. */
  failure: { repositoryFailure?: RepositoryFailure | null; cause: string; code?: string | null; reason?: string | null; error?: string | null; source: 'report' | 'error' } | null;
  tokens: number | null;
  costUsd: number | null;
}

/** The search index's upkeep over the window. */
export interface Upkeep {
  task: string;
  /** When an upkeep run last completed, whenever that was. */
  lastSuccessAt: number | null;
  /** Upkeep runs started inside the window that failed, retries included. */
  failedInWindow: number;
  /** Upkeep runs that failed after the last success, and the first of them: the ones no success has answered yet. */
  unrecovered: { runs: number; since: number; latestFailure?: { projectId: string; runId: string; at: number; code: string | null } } | null;
}

/** Whether the rollups cover history yet: 'building' while the first catch-up runs, never a partial total. */
type WorkState = 'ready' | 'building';

export interface WorkAnswer {
  window: { since: number; until: number };
  state: WorkState;
  /** Full-window counts on a supported UTC window; null on any other range, and while the rollups are building. */
  summary: WorkOutcome[] | null;
  /** The window's run evidence, newest first, one page at a time. */
  timeline: WorkRun[];
  /** Whether another run-evidence page follows this one; `summary` covers the whole window. */
  hasMore: boolean;
  /** Fetches the next page of run evidence for the same window and Project set. */
  cursor: string | null;
  /** Each Project's current code map, whatever the window. */
  maps: WorkMap[];
  upkeep: Upkeep;
}

const num = (value: unknown): number => Number(value ?? 0);
const orNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const range = (low: unknown, high: unknown): Range => (low === null || low === undefined || high === null || high === undefined ? null : [Number(low), Number(high)]);
const wordsKey = (projectId: unknown, task: unknown): string => `${String(projectId)}\u0000${String(task)}`;

/** The upkeep rows of the upkeep statement, summed over the Projects. */
function upkeepOf(rows: readonly Record<string, unknown>[]): Upkeep {
  let lastSuccessAt: number | null = null;
  let failedInWindow = 0;
  let unrecovered = 0;
  let since: number | null = null;
  let latestFailure: NonNullable<Upkeep['unrecovered']>['latestFailure'];
  for (const row of rows) {
    const last = orNull(row.last_success);
    if (last !== null && (lastSuccessAt === null || last > lastSuccessAt)) lastSuccessAt = last;
    failedInWindow += num(row.failed_in_window);
    const open = num(row.unrecovered);
    unrecovered += open;
    if (typeof row.latest_failure === 'string') {
      const latest = JSON.parse(row.latest_failure) as { projectId: string; runId: string; at: number; code: string | null; error: string | null };
      if (latestFailure === undefined || latest.at > latestFailure.at || (latest.at === latestFailure.at && latest.runId > latestFailure.runId)) {
        latestFailure = { projectId: latest.projectId, runId: latest.runId, at: latest.at, code: runErrorCode(latest.error, latest.code) };
      }
    }
    const first = orNull(row.unrecovered_since);
    if (open > 0 && first !== null && (since === null || first < since)) since = first;
  }
  return { task: EMBEDDING_TASK, lastSuccessAt, failedInWindow, unrecovered: unrecovered > 0 && since !== null ? { runs: unrecovered, since, ...(latestFailure === undefined ? {} : { latestFailure }) } : null };
}

/** The search index's upkeep over the set's Projects and the window. */
export async function readUpkeep(db: RelationalStore, set: ProjectSet, since: number, until: number): Promise<Upkeep> {
  return upkeepOf(await upkeepRows(db, set, since, until));
}

/** The rollups' answer for a supported UTC window, or null while they are still building. */
async function summaryOf(db: RelationalStore, set: ProjectSet, window: UtcWindow, now: number): Promise<WorkOutcome[] | null> {
  const read = await workSummary(db, set, window, window.until > now);
  if (!read.ready.history || !read.ready.admission) return null;
  const sessionsBy = new Map(read.sessions.map(row => [wordsKey(row.project_id, row.task), num(row.sessions)]));
  const headsBy = new Map(read.heads.map(row => [wordsKey(row.project_id, row.task), row]));
  const outcomes = new Map<string, WorkOutcome>();
  const outcomeOf = (projectId: string, task: string): WorkOutcome => {
    const id = wordsKey(projectId, task);
    let outcome = outcomes.get(id);
    if (outcome === undefined) {
      const kind = OUTCOME_KINDS[task]!;
      outcome = { projectId, kind, task, runs: {}, outcome: { spores: 0, sessions: kind === 'map' ? 0 : sessionsBy.get(id) ?? 0, maps: 0 }, failedWithOutput: 0, failed: 0, failure: null,
        latestAt: orNull(headsBy.get(id)?.latest_at), tokens: 0, costUsd: 0, runsWithoutCost: 0, spend: { tokens: null, costUsd: null, durationMs: null } };
      outcomes.set(id, outcome);
    }
    return outcome;
  };
  for (const row of read.daily) {
    const outcome = outcomeOf(String(row.project_id), String(row.task));
    const status = String(row.status);
    const runs = num(row.runs);
    const produced = num(row.produced);
    outcome.runs[status] = runs;
    outcome.outcome.spores += num(row.spores);
    if (outcome.kind === 'map') outcome.outcome.maps += produced;
    if (status === 'failed') { outcome.failedWithOutput += produced; outcome.failed += runs - produced; }
    outcome.tokens += num(row.tokens);
    outcome.costUsd += num(row.cost);
    outcome.runsWithoutCost += num(row.no_cost);
    if (status === 'completed') outcome.spend = { tokens: range(row.tokens_low, row.tokens_high), costUsd: range(row.cost_low, row.cost_high), durationMs: range(row.duration_low, row.duration_high) };
  }
  const later = (outcome: WorkOutcome, at: number | null) => { if (at !== null && (outcome.latestAt === null || at > outcome.latestAt)) outcome.latestAt = at; };
  for (const row of read.queued) {
    const outcome = outcomeOf(String(row.project_id), String(row.task));
    outcome.runs.queued = (outcome.runs.queued ?? 0) + num(row.runs);
    later(outcome, orNull(row.latest));
  }
  for (const row of read.running) {
    const outcome = outcomeOf(String(row.project_id), String(row.task));
    outcome.runs[String(row.status)] = num(row.runs);
    later(outcome, orNull(row.latest));
  }
  for (const [id, outcome] of outcomes) {
    const head = headsBy.get(id);
    if (head?.failed_run == null || outcome.failed === 0) continue;
    outcome.failure = { runs: outcome.failed, latestAt: num(head.failed_at), latestRunId: String(head.failed_run), unresolved: num(head.unresolved) === 1 };
  }
  return [...outcomes.values()].sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0) || a.projectId.localeCompare(b.projectId) || a.task.localeCompare(b.task));
}

/** A row of the timeline as the page lists it. */
function workRunOf(row: Record<string, unknown>): WorkRun {
  const task = String(row.task);
  const kind = OUTCOME_KINDS[task]!;
  const produced = num(row.produced) === 1;
  const failed = String(row.status) === 'failed';
  const titled = row.titled_session == null ? null : String(row.titled_session);
  const error = typeof row.error === 'string' && row.error.trim() !== '' ? row.error : null;
  const code = runErrorCode(error, typeof row.error_code === 'string' ? row.error_code : null);
  const repositoryFailure = parseRepositoryFailure({ code: row.repository_failure_code, summary: row.repository_failure_summary });
  return {
    ...runAccounting(row.usage_data, row.cost_provenance),
    requested: requestedProfile(row.requested_profile),
    queuedAt: orNull(row.queued_at), startedAt: orNull(row.started_at), completedAt: orNull(row.completed_at),
    harness: row.harness == null ? null : String(row.harness),
    model: row.model == null ? null : heldPartition(String(row.model)).label,
    provider: row.provider == null ? null : String(row.provider),
    id: String(row.id),
    projectId: String(row.project_id),
    task,
    kind,
    status: String(row.status),
    result: (failed ? (produced ? 'failed_with_output' : 'failed') : (produced ? 'produced' : 'unchanged')) as RunResult,
    at: orNull(row.at),
    outcome: {
      spores: num(row.spores),
      sessions: kind === 'title' ? (produced && titled !== null ? 1 : 0) : num(row.spore_sessions),
      maps: kind === 'map' && produced ? 1 : 0,
    },
    sessionId: kind === 'title' ? titled : null,
    failure: !failed ? null : { ...(repositoryFailure === null ? {} : { repositoryFailure }), code: code ?? 'run_failed', cause: error ?? 'the run failed without saying why', ...(row.error_reason == null ? {} : { reason: String(row.error_reason) }), error, source: 'error' },
    tokens: orNull(row.tokens_used),
    costUsd: orNull(row.cost_usd),
  };
}

/** What the Deployment's runs produced in the set's Projects over the window, its end excluded. */
export async function readWork(db: RelationalStore, set: ProjectSet, since: number, until: number, cursor?: TimelineCursor, now = Date.now()): Promise<WorkAnswer> {
  const window = supportedUtcWindow(since, until);
  const [summary, timeline, maps, upkeep, ready] = await Promise.all([
    window === null || cursor !== undefined ? Promise.resolve(null) : summaryOf(db, set, window, now),
    workTimeline(db, set, since, until, cursor),
    currentMaps(db, set),
    readUpkeep(db, set, since, until),
    window === null || cursor !== undefined ? workHistoryReady(db) : Promise.resolve(true),
  ]);
  const runs = timeline.rows.map(workRunOf);
  const last = runs.at(-1);
  const state: WorkState = (window !== null && cursor === undefined && summary === null) || !ready ? 'building' : 'ready';
  return {
    window: { since, until }, state, summary,
    timeline: state === 'building' ? [] : runs,
    hasMore: state !== 'building' && timeline.hasMore,
    cursor: state !== 'building' && timeline.hasMore && last !== undefined && last.at !== null ? JSON.stringify([last.at, last.projectId, last.id]) : null,
    maps: maps.map(row => ({ projectId: String(row.project_id), branch: String(row.repository_branch), commit: String(row.repository_commit), generatedAt: num(row.generated_at), sourceRunId: String(row.source_run_id) })),
    upkeep,
  };
}

/** The last seven UTC days through today, the window a read covers when it names none. */
export function defaultWorkWindow(now: number): { since: number; until: number } {
  const until = Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  return { since: until - DEFAULT_WORK_WINDOW_DAYS * DAY_MS, until };
}

/** An outcome task that is failing in a Project: its runs that failed having produced nothing after the task last completed there. */
interface FailingOutcome {
  projectId: string;
  task: string;
  kind: OutcomeKind;
  failures: number;
  since: number;
  latestAt: number;
  latestRunId: string;
}

/**
 * The outcome tasks of `tasks` failing in any Project that accepts capture: runs that failed within the lookback having
 * produced nothing, and that no completed run of the same task in the same Project started after. A failed run that
 * saved its output is not a failed outcome, and a failure a later run recovered from is not a failure at all.
 */
export async function failingOutcomes(db: RelationalStore, tasks: readonly string[], lookbackFrom: number): Promise<FailingOutcome[]> {
  if (tasks.length === 0) return [];
  return (await failingRows(db, tasks, lookbackFrom)).map((row) => ({
    projectId: String(row.project_id),
    task: String(row.task),
    kind: OUTCOME_KINDS[String(row.task)]!,
    failures: num(row.failures),
    since: num(row.since),
    latestAt: num(row.latest_at),
    latestRunId: String(row.latest_run),
  }));
}

/** Runs, in one Project, that ended without the agent's account of its steps, against the runs that owed one. */
interface AuditFailures {
  projectId: string;
  runs: number;
  closed: number;
  since: number;
  latestAt: number;
  latestRunId: string;
}

/**
 * Per Project, the runs of `tasks` a worker claimed that ended from `lookbackFrom` on, and how many of them ended
 * without their audit (`report_without_audit`), for each Project where any did.
 */
export async function auditFailures(db: RelationalStore, tasks: readonly string[], lookbackFrom: number): Promise<AuditFailures[]> {
  if (tasks.length === 0) return [];
  return (await auditRows(db, AUDIT_CODE, tasks, lookbackFrom)).map((row) => ({
    projectId: String(row.project_id), runs: num(row.runs), closed: num(row.closed),
    since: num(row.since), latestAt: num(row.latest_at), latestRunId: String(row.latest_run),
  }));
}

const AUDIT_CODE: RunErrorCode = 'report_without_audit';

/** Queued runs of Projects that accept capture held for a worker capability from before `queuedBefore`, by the capability that holds them. */
export async function capabilityHolds(db: RelationalStore, capabilities: readonly string[], queuedBefore: number): Promise<{ capability: string; runs: number; since: number }[]> {
  if (capabilities.length === 0) return [];
  return (await holdRows(db, capabilities, queuedBefore)).map((row) => ({ capability: String(row.held_by), runs: num(row.runs), since: num(row.since) }));
}

/** Queued runs of Projects that accept capture that a worker would take, the tasks a runtime serves itself excepted, and the oldest of them. */
export async function runsAwaitingWorker(db: RelationalStore, runtimeServed: readonly string[]): Promise<{ runs: number; since: number | null }> {
  const row = await awaitingRow(db, runtimeServed);
  return { runs: num(row.runs), since: orNull(row.since) };
}
