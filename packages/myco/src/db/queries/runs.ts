/**
 * Agent run CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { epochSeconds } from '@myco/constants.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import type { ProviderType, ReasoningLevel, HarnessId } from '@myco/agent/types.js';
import type { CostSource } from '@myco/agent/cost/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of runs returned by listRuns when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default run status for new runs. */
const DEFAULT_STATUS = 'pending';

/** Run status indicating the run is currently executing. */
export const STATUS_RUNNING = 'running';

/** Run status for a successfully completed run. */
export const STATUS_COMPLETED = 'completed';

/** Run status for a run that encountered an error. */
export const STATUS_FAILED = 'failed';

/** Run status for a run skipped by gating or preconditions. */
export const STATUS_SKIPPED = 'skipped';

/** Resume status used when a failed/interrupted run can be resumed. */
export const RESUME_STATUS_READY = 'ready';

/**
 * Resume status used when a run's underlying SDK session has expired
 * (Claude Agent SDK sessions TTL out after hours/days on Anthropic's side).
 * Without this terminal state the scheduler would pick the run up every
 * tick, re-attach to the dead session, crash within ~100s on 0 turns, and
 * loop forever. `resumable=0` stops the loop; the status tells operators
 * why the run is final.
 */
export const RESUME_STATUS_SESSION_EXPIRED = 'session_expired';

/**
 * Resume status used when a run has burned through the scheduler's resume
 * retry budget (`resume_attempts` >= cap). Terminal like `session_expired`:
 * `resumable=0` is what actually stops the scheduler loop —
 * `getLatestResumableRunForTask` filters on `resumable = 1` and never reads
 * `resume_status` — but the status tells operators why the run is final.
 */
export const RESUME_STATUS_EXHAUSTED = 'exhausted';

/**
 * Resume status used when a newer, equivalent run (same agent/task/project
 * scope/dry_run — same scheduled job) has since completed. A resumable
 * failed run left behind by an OLDER dispatch is stale by definition once
 * an equivalent run finishes — resuming it would re-execute work against
 * checkpoints, gates, and watermarks superseded by the completion. See
 * `supersedeEquivalentResumableRuns` (completion-time sweep) and the
 * `gateScheduledResume` belt (task-scheduling.ts) for the two enforcement
 * points.
 */
export const RESUME_STATUS_SUPERSEDED = 'superseded';

/**
 * Resume status used when the run-end postcondition validator fails on a
 * resume attempt that executed ZERO fresh phases (every phase was restored
 * from checkpoints — see executor.ts's `executedPhaseCount === 0` check).
 * Distinct from a normal postcondition failure on a run that did execute
 * work: an all-restored resume can never satisfy the missing contract by
 * retrying, because retrying re-runs nothing. Terminal-marking here (instead
 * of `ready`) stops the scheduler from burning 3 resume attempts on a run
 * that is deterministically unresumable.
 */
export const RESUME_STATUS_POSTCONDITION_UNSATISFIABLE = 'postcondition_unsatisfiable';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunInsert {
  id: string;
  project_id?: string | null;
  agent_id: string;
  task?: string | null;
  instruction?: string | null;
  status?: string;
  harness?: HarnessId | null;
  provider?: ProviderType | null;
  model?: string | null;
  session_ref?: string | null;
  resumable?: number | null;
  resume_status?: string | null;
  resume_mode?: string | null;
  resumed_at?: number | null;
  /** Scheduled resume retries consumed so far. Defaults to 0. */
  resume_attempts?: number | null;
  checkpoints?: string | null;
  usage_data?: string | null;
  started_at?: number | null;
  completed_at?: number | null;
  tokens_used?: number | null;
  cost_usd?: number | null;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  cost_source?: CostSource | null;
  cost_data?: string | null;
  actions_taken?: string | null;
  error?: string | null;
  /** RunOptions.runContext serialized as JSON. Null when the run had none. */
  run_context?: string | null;
  /** Whether this run was executed in dry-run mode (intercepted writes). */
  dryRun?: boolean;
  /**
   * Reasoning level actually applied to this run (from override or resolved
   * config). Null when no explicit level was set.
   */
  reasoningLevel?: ReasoningLevel | null;
  /**
   * Raw RunOptions.executionOverrides packet that produced this run. Stored
   * as JSON; accepts null, undefined, or a plain object (serialized via
   * JSON.stringify). Null when the run used task-default config throughout.
   */
  executionOverrides?: Record<string, unknown> | null;
}

export interface RunRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string;
  harness: HarnessId | null;
  provider: ProviderType | null;
  model: string | null;
  session_ref: string | null;
  resumable: number;
  resume_status: string | null;
  resume_mode: string | null;
  resumed_at: number | null;
  /** Scheduled resume retries consumed so far. */
  resume_attempts: number;
  checkpoints: string | null;
  usage_data: string | null;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number | null;
  cost_usd: number | null;
  actual_cost_usd: number | null;
  estimated_cost_usd: number | null;
  cost_source: CostSource | null;
  cost_data: string | null;
  actions_taken: string | null;
  error: string | null;
  /** RunOptions.runContext serialized as JSON. Null when the run had none. */
  run_context: string | null;
  /** True when the run was executed in dry-run mode. */
  dry_run: boolean;
  /** Reasoning level applied to this run, or null if unset. */
  reasoning_level: ReasoningLevel | null;
  /**
   * Parsed executionOverrides packet. Null when absent, unparseable, or not
   * set. JSON.parse errors are swallowed (corruption tolerance).
   */
  execution_overrides: Record<string, unknown> | null;
}

export interface RunUpdate {
  status?: string;
  task?: string | null;
  instruction?: string | null;
  harness?: HarnessId | null;
  provider?: ProviderType | null;
  model?: string | null;
  session_ref?: string | null;
  started_at?: number | null;
  resumable?: number | null;
  resume_status?: string | null;
  resume_mode?: string | null;
  resumed_at?: number | null;
  resume_attempts?: number;
  checkpoints?: string | null;
  usage_data?: string | null;
  completed_at?: number | null;
  tokens_used?: number | null;
  cost_usd?: number | null;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  cost_source?: CostSource | null;
  cost_data?: string | null;
  actions_taken?: string | null;
  error?: string | null;
  run_context?: string | null;
  dryRun?: boolean;
  reasoningLevel?: ReasoningLevel | null;
  executionOverrides?: Record<string, unknown> | null;
}

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
  scope: ProjectScope;
  agent_id?: string;
  status?: string;
  task?: string;
  search?: string;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const RUN_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'task',
  'instruction',
  'status',
  'harness',
  'provider',
  'model',
  'session_ref',
  'resumable',
  'resume_status',
  'resume_mode',
  'resumed_at',
  'resume_attempts',
  'checkpoints',
  'usage_data',
  'started_at',
  'completed_at',
  'tokens_used',
  'cost_usd',
  'actual_cost_usd',
  'estimated_cost_usd',
  'cost_source',
  'cost_data',
  'actions_taken',
  'error',
  'run_context',
  'dry_run',
  'reasoning_level',
  'execution_overrides',
] as const;

const SELECT_COLUMNS = RUN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON column value tolerantly. Returns null for null/undefined inputs
 * and for any JSON.parse failure (tolerates corruption without throwing). Only
 * object (non-array) payloads are returned; other shapes become null.
 */
function parseJsonObjectColumn(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize an executionOverrides payload for insert/update. Accepts null,
 * undefined, or a plain object — all other shapes round-trip as NULL in the
 * column. JSON.stringify failures also degrade to NULL.
 */
function serializeExecutionOverrides(
  value: Record<string, unknown> | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

const COST_SOURCES: readonly CostSource[] = ['actual', 'estimated', 'unavailable'];
const REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'default', 'high'];

function toCostSourceOrNull(value: unknown): CostSource | null {
  return typeof value === 'string' && (COST_SOURCES as readonly string[]).includes(value)
    ? (value as CostSource)
    : null;
}

function toReasoningLevelOrNull(value: unknown): ReasoningLevel | null {
  return typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value)
    ? (value as ReasoningLevel)
    : null;
}

function toRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    task: (row.task as string) ?? null,
    instruction: (row.instruction as string) ?? null,
    status: row.status as string,
    harness: (row.harness as HarnessId) ?? null,
    provider: (row.provider as ProviderType) ?? null,
    model: (row.model as string) ?? null,
    session_ref: (row.session_ref as string) ?? null,
    resumable: Number(row.resumable ?? 0),
    resume_status: (row.resume_status as string) ?? null,
    resume_mode: (row.resume_mode as string) ?? null,
    resumed_at: (row.resumed_at as number) ?? null,
    resume_attempts: Number(row.resume_attempts ?? 0),
    checkpoints: (row.checkpoints as string) ?? null,
    usage_data: (row.usage_data as string) ?? null,
    started_at: (row.started_at as number) ?? null,
    completed_at: (row.completed_at as number) ?? null,
    tokens_used: (row.tokens_used as number) ?? null,
    cost_usd: (row.cost_usd as number) ?? null,
    actual_cost_usd: (row.actual_cost_usd as number) ?? null,
    estimated_cost_usd: (row.estimated_cost_usd as number) ?? null,
    cost_source: toCostSourceOrNull(row.cost_source),
    cost_data: (row.cost_data as string) ?? null,
    actions_taken: (row.actions_taken as string) ?? null,
    error: (row.error as string) ?? null,
    run_context: (row.run_context as string) ?? null,
    dry_run: Boolean(Number(row.dry_run ?? 0)),
    reasoning_level: toReasoningLevelOrNull(row.reasoning_level),
    execution_overrides: parseJsonObjectColumn(row.execution_overrides),
  };
}

function buildRunsWhere(
  options: Omit<ListRunsOptions, 'limit' | 'offset'>,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  appendProjectCondition(conditions, params, options.scope);

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(options.agent_id);
  }
  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  }
  if (options.task !== undefined) {
    conditions.push(`task = ?`);
    params.push(options.task);
  }
  if (options.search !== undefined && options.search.length > 0) {
    conditions.push(`task LIKE ?`);
    params.push(`%${options.search}%`);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Columns in RunUpdate that map 1:1 to a column name. Camel-cased keys
 * (`dryRun`, `reasoningLevel`, `executionOverrides`) are handled
 * separately below because their column names differ, `dryRun` needs
 * boolean->integer coercion, and `executionOverrides` serializes to JSON.
 *
 * `started_at` is deliberately absent: it is a run's ORIGINAL dispatch
 * time and must never be re-stamped by an update (see executor.ts's
 * resume branch and the recency-sort comments on listRuns/getRunningRun*
 * below). Excluding it here makes that guarantee structural — even a
 * caller that accidentally includes `started_at` in a RunUpdate cannot
 * move the column, because `buildUpdateClauses` only emits SET clauses
 * for keys present in this list.
 */
const UPDATE_COLUMNS: readonly (keyof RunUpdate)[] = [
  'status',
  'task',
  'instruction',
  'harness',
  'provider',
  'model',
  'session_ref',
  'resumable',
  'resume_status',
  'resume_mode',
  'resumed_at',
  'resume_attempts',
  'checkpoints',
  'usage_data',
  'completed_at',
  'tokens_used',
  'cost_usd',
  'actual_cost_usd',
  'estimated_cost_usd',
  'cost_source',
  'cost_data',
  'actions_taken',
  'error',
  'run_context',
];

function buildUpdateClauses(update: RunUpdate): { setClauses: string[]; params: unknown[] } {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const column of UPDATE_COLUMNS) {
    if (column in update) {
      setClauses.push(`${column} = ?`);
      params.push(update[column]);
    }
  }
  if ('dryRun' in update) {
    setClauses.push('dry_run = ?');
    params.push(update.dryRun ? 1 : 0);
  }
  if ('reasoningLevel' in update) {
    setClauses.push('reasoning_level = ?');
    params.push(update.reasoningLevel ?? null);
  }
  if ('executionOverrides' in update) {
    setClauses.push('execution_overrides = ?');
    params.push(serializeExecutionOverrides(update.executionOverrides));
  }
  return { setClauses, params };
}

function forEachChunk<T>(items: T[], size: number, fn: (chunk: T[]) => void): void {
  for (let i = 0; i < items.length; i += size) {
    fn(items.slice(i, i + size));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function insertRun(data: RunInsert): RunRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO agent_runs (
       id, project_id, agent_id, task, instruction, status,
       harness, provider, model, session_ref, resumable,
       resume_status, resume_mode, resumed_at, resume_attempts, checkpoints, usage_data,
       started_at, completed_at, tokens_used, cost_usd,
       actual_cost_usd, estimated_cost_usd, cost_source, cost_data,
       actions_taken, error, run_context, dry_run,
       reasoning_level, execution_overrides
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    data.id,
    data.project_id ?? null,
    data.agent_id,
    data.task ?? null,
    data.instruction ?? null,
    data.status ?? DEFAULT_STATUS,
    data.harness ?? null,
    data.provider ?? null,
    data.model ?? null,
    data.session_ref ?? null,
    data.resumable ?? 0,
    data.resume_status ?? null,
    data.resume_mode ?? null,
    data.resumed_at ?? null,
    data.resume_attempts ?? 0,
    data.checkpoints ?? null,
    data.usage_data ?? null,
    data.started_at ?? null,
    data.completed_at ?? null,
    data.tokens_used ?? null,
    data.cost_usd ?? null,
    data.actual_cost_usd ?? null,
    data.estimated_cost_usd ?? null,
    data.cost_source ?? null,
    data.cost_data ?? null,
    data.actions_taken ?? null,
    data.error ?? null,
    data.run_context ?? null,
    data.dryRun ? 1 : 0,
    data.reasoningLevel ?? null,
    serializeExecutionOverrides(data.executionOverrides),
  );

  return getRun(data.id, { kind: 'all' })!;
}

export function getRun(id: string, scope: ProjectScope): RunRow | null {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export function listRuns(options: ListRunsOptions): RunRow[] {
  const db = getDatabase();
  const { where, params } = buildRunsWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  // Orders by the CURRENT-attempt clock (`COALESCE(resumed_at,
  // started_at)`), not `started_at` alone — `started_at` is preserved as
  // each run's ORIGINAL dispatch time (see executor.ts), so a run resumed
  // long after its first dispatch still surfaces near the top of the list
  // it was just active in, matching the rail's ACTIVE/TODAY/YESTERDAY
  // section bucketing (RunList.tsx's `sectionRows` call uses the same
  // attempt-start value client-side).
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     ${where}
     ORDER BY COALESCE(resumed_at, started_at) DESC NULLS LAST
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(toRunRow);
}

export function countRuns(
  options: Omit<ListRunsOptions, 'limit' | 'offset'>,
): number {
  const db = getDatabase();
  const { where, params } = buildRunsWhere(options);
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM agent_runs ${where}`,
  ).get(...params) as { count: number };
  return row.count;
}

/**
 * Apply a run update without re-SELECTing the row. Returns the number of
 * changed rows. Use this in hot write paths (checkpoint persistence,
 * in-run cost updates) where the caller does not need the updated row.
 */
export function applyRunUpdate(id: string, update: RunUpdate, scope: ProjectScope): number {
  const { setClauses, params } = buildUpdateClauses(update);
  if (setClauses.length === 0) return 0;
  params.push(id);
  const conditions = ['id = ?'];
  appendProjectCondition(conditions, params, scope);
  const info = getDatabase().prepare(
    `UPDATE agent_runs
     SET ${setClauses.join(', ')}
     WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  return info.changes;
}

export function updateRun(id: string, update: RunUpdate, scope: ProjectScope): RunRow | null {
  const { setClauses } = buildUpdateClauses(update);
  if (setClauses.length === 0) return getRun(id, scope);
  const changes = applyRunUpdate(id, update, scope);
  if (changes === 0) return null;
  return getRun(id, scope);
}

export function updateRunStatus(
  id: string,
  status: string,
  completion: RunUpdate | undefined,
  scope: ProjectScope,
): RunRow | null {
  return updateRun(id, { status, ...completion }, scope);
}

// Orders by the CURRENT-attempt clock (`COALESCE(resumed_at, started_at)`),
// matching getRunningRunForTask below — `started_at` alone would surface a
// stale never-resumed running row over one whose resume attempt is actually
// the most recent activity for this agent.
export function getRunningRun(agentId: string, scope: ProjectScope): RunRow | null {
  const db = getDatabase();
  const conditions = ['agent_id = ?', 'status = ?'];
  const params: unknown[] = [agentId, STATUS_RUNNING];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(resumed_at, started_at) DESC NULLS LAST
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export interface RunningRunRef {
  id: string;
  started_at: number | null;
  /**
   * True when `maxAgeSeconds` was given and the row's CURRENT-attempt clock
   * — `COALESCE(resumed_at, started_at)` — exceeds the cutoff: a 'running'
   * row no run loop is still driving (e.g. an update killed the process
   * between boot-recovery sweeps). Deliberately NOT `started_at` alone: a
   * resumed run preserves its original dispatch time (see executor.ts), so
   * gauging staleness off `started_at` would immediately flag a
   * just-resumed long-dormant run as stale even though its current attempt
   * is seconds old. Callers treat a stale ref as not-running and log it; the
   * row itself is NOT mutated here (boot recovery's
   * `markRunningRunsInterrupted` owns that).
   */
  stale: boolean;
}

export function getRunningRunForTask(
  agentId: string,
  taskName: string,
  scope: ProjectScope,
  maxAgeSeconds?: number,
): RunningRunRef | null {
  const db = getDatabase();
  const conditions = ['agent_id = ?', 'task = ?', 'status = ?'];
  const params: unknown[] = [agentId, taskName, STATUS_RUNNING];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT id, started_at, resumed_at FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY COALESCE(resumed_at, started_at) DESC NULLS LAST
     LIMIT 1`,
  ).get(...params) as { id: string; started_at: number | null; resumed_at: number | null } | undefined;
  if (!row) return null;
  const attemptClock = row.resumed_at ?? row.started_at;
  const stale = maxAgeSeconds !== undefined
    && attemptClock !== null
    && epochSeconds() - attemptClock > maxAgeSeconds;
  return { id: row.id, started_at: row.started_at ?? null, stale };
}

/**
 * Atomically bump `resume_attempts` for a run. Used by the scheduler before
 * each resume dispatch so the retry budget survives daemon restarts.
 * Returns the number of changed rows.
 */
export function incrementRunResumeAttempts(id: string, scope: ProjectScope): number {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const info = db.prepare(
    `UPDATE agent_runs
     SET resume_attempts = resume_attempts + 1
     WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  return info.changes;
}

/**
 * Refund one resume attempt, flooring at 0. Only dispatches that actually
 * START a resume consume budget — a dispatch the executor skips
 * (already_running, e.g. a long manual run of the same task) must hand its
 * attempt back, or ticks during that run would exhaust the budget with
 * zero resumes executed. Returns the number of changed rows.
 */
export function refundRunResumeAttempt(id: string, scope: ProjectScope): number {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);
  const info = db.prepare(
    `UPDATE agent_runs
     SET resume_attempts = MAX(resume_attempts - 1, 0)
     WHERE ${conditions.join(' AND ')}`,
  ).run(...params);
  return info.changes;
}

export function getLatestResumableRunForTask(
  agentId: string,
  taskName: string,
  scope: ProjectScope,
): RunRow | null {
  const db = getDatabase();
  const conditions = [
    'agent_id = ?',
    'task = ?',
    'resumable = 1',
    'status = ?',
  ];
  const params: unknown[] = [agentId, taskName, STATUS_FAILED];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

/**
 * Append the supersede equivalence-key predicate to an in-progress
 * WHERE-clause builder: same `agent_id` + `task` + project scope (via
 * `appendProjectCondition`) + `dry_run`. Shared by the completion-time
 * sweep and the gate-time belt so the two enforcement points can never
 * drift apart on what counts as "equivalent" — this is the natural
 * identity of "the same scheduled job": a manual and a scheduled run of
 * the same task+project+scope+dry_run ARE the same job and are meant to
 * supersede one another. `instruction` is deliberately EXCLUDED: tasks
 * like skill-evolve build their instruction dynamically per run (it
 * embeds live skill state), so two runs of the same scheduled job never
 * share an instruction string — keying equivalence on it meant a
 * completed run could never retire that job's resumable failed runs, and
 * they accumulated forever. `dry_run` pinning is still load-bearing: the
 * executor restores `dryRun` on resume, so without it a completed live
 * run would wrongly supersede or block a dry-run-scoped failed run.
 */
function appendSupersedeEquivalenceCondition(
  conditions: string[],
  params: unknown[],
  match: { agentId: string; taskName: string; scope: ProjectScope; dryRun: boolean },
): void {
  conditions.push('agent_id = ?', 'task = ?');
  params.push(match.agentId, match.taskName);
  appendProjectCondition(conditions, params, match.scope);
  conditions.push('dry_run = ?');
  params.push(match.dryRun ? 1 : 0);
}

/**
 * Completion-time supersede sweep (Part 1 primary). Called from the
 * executor's success path immediately after a run completes, with that
 * run's own (agentId, taskName, scope, dryRun) as the equivalence key.
 * Terminal-marks (`resumable=0`, `resume_status='superseded'`) every OTHER
 * currently-resumable failed run matching the key — structural, no
 * timestamp comparison needed: anything still resumable when an
 * equivalent run completes is stale BY DEFINITION, because the
 * just-completed run's dispatch necessarily started no earlier than the
 * failed run's most recent attempt. Swept runs hit the existing
 * resumable-guard 400 at the manual resume endpoint automatically
 * (agent-runs.ts).
 *
 * `excludeRunId` is the completing run's own id — never supersede itself.
 */
export function supersedeEquivalentResumableRuns(
  excludeRunId: string,
  match: { agentId: string; taskName: string; scope: ProjectScope; dryRun: boolean },
): number {
  const db = getDatabase();
  const conditions = ['id != ?', 'resumable = 1', 'status = ?'];
  const params: unknown[] = [excludeRunId, STATUS_FAILED];
  appendSupersedeEquivalenceCondition(conditions, params, match);
  const info = db.prepare(
    `UPDATE agent_runs
     SET resumable = 0,
         resume_status = ?
     WHERE ${conditions.join(' AND ')}`,
  ).run(RESUME_STATUS_SUPERSEDED, ...params);
  return info.changes;
}

/**
 * Gate-time supersede belt (Part 1 secondary). Defends legacy rows written
 * before the completion-time sweep existed, and any race the sweep's
 * single-completion trigger can't see. Returns the newest COMPLETED
 * equivalent run whose `completed_at` is newer than the failed run's own
 * ORIGINAL dispatch (`started_at`) — a resume attempt never re-stamps
 * `started_at` (see executor.ts), so it is stable dispatch-order evidence:
 * a completion newer than the failed run's first dispatch necessarily
 * postdates whatever work the failed run represents, resumed or not. The
 * `COALESCE(F.started_at, 0)` guard only covers a pathological NULL
 * `started_at`, never a resume — resumed rows keep their real dispatch
 * time. Returns null when no such run exists. Callers that only need the
 * yes/no answer (`gateScheduledResume`) test the return for non-null;
 * callers that need to NAME the superseding run (the manual resume
 * endpoint's 409) read `.id` off the row.
 */
export function findNewerCompletedEquivalentRun(
  failedRun: Pick<RunRow, 'id' | 'started_at' | 'completed_at'>,
  match: { agentId: string; taskName: string; scope: ProjectScope; dryRun: boolean },
): RunRow | null {
  const db = getDatabase();
  const conditions = ['id != ?', 'status = ?', 'completed_at IS NOT NULL'];
  const params: unknown[] = [failedRun.id, STATUS_COMPLETED];
  appendSupersedeEquivalenceCondition(conditions, params, match);
  conditions.push('completed_at > ?');
  params.push(failedRun.started_at ?? 0);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY completed_at DESC
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

/**
 * Boolean convenience wrapper over `findNewerCompletedEquivalentRun` for
 * callers that only need the yes/no answer.
 */
export function hasNewerCompletedEquivalentRun(
  failedRun: Pick<RunRow, 'id' | 'started_at' | 'completed_at'>,
  match: { agentId: string; taskName: string; scope: ProjectScope; dryRun: boolean },
): boolean {
  return findNewerCompletedEquivalentRun(failedRun, match) !== null;
}

/**
 * Boot-time supersede sweep (Part 1 one-time backfill). The completion-time
 * sweep above only fires on FUTURE completions — this catches stale
 * resumable rows that predate the sweep's existence (or were left behind by
 * a daemon crash before the completing run's success path ran). Terminal-
 * marks every resumable failed run F for which ANY completed run C shares
 * F's equivalence key (agent_id, task, project scope, dry_run) and has
 * `completed_at` newer than F's ORIGINAL dispatch (`started_at`) — same
 * predicate as the gate-time belt (`hasNewerCompletedEquivalentRun`),
 * expressed as a single correlated-EXISTS UPDATE so the whole scope sweeps
 * in one SQL pass. A completed equivalent newer than the failed run's
 * original dispatch supersedes it, resumed or not — `started_at` is stable
 * dispatch-order evidence because a resume never re-stamps it (see
 * executor.ts). `COALESCE(F.started_at, 0)` only guards a pathological
 * NULL. Safe to run on every boot: a fully-swept vault matches zero rows.
 */
export function sweepStaleSupersededRuns(scope: ProjectScope): number {
  const db = getDatabase();
  const outerConditions: string[] = [];
  const outerParams: unknown[] = [];
  appendProjectCondition(outerConditions, outerParams, scope, 'F');
  const outerScopeClause = outerConditions.length > 0 ? `AND ${outerConditions.join(' AND ')}` : '';

  const info = db.prepare(
    `UPDATE agent_runs AS F
     SET resumable = 0,
         resume_status = ?
     WHERE F.resumable = 1
       AND F.status = ?
       ${outerScopeClause}
       AND EXISTS (
         SELECT 1 FROM agent_runs AS C
         WHERE C.id != F.id
           AND C.status = ?
           AND C.completed_at IS NOT NULL
           AND C.agent_id = F.agent_id
           AND C.task = F.task
           AND COALESCE(C.project_id, '') = COALESCE(F.project_id, '')
           AND C.dry_run = F.dry_run
           AND C.completed_at > COALESCE(F.started_at, 0)
       )`,
  ).run(RESUME_STATUS_SUPERSEDED, STATUS_FAILED, STATUS_COMPLETED, ...outerParams);
  return info.changes;
}

export function markRunningRunsInterrupted(message: string, scope: ProjectScope): number {
  const db = getDatabase();
  const conditions = ['status = ?'];
  const params: unknown[] = [STATUS_RUNNING];
  appendProjectCondition(conditions, params, scope);
  const info = db.prepare(
    `UPDATE agent_runs
     SET status = ?,
         resumable = 1,
         resume_status = ?,
         error = COALESCE(error, ?)
     WHERE ${conditions.join(' AND ')}`,
  ).run(STATUS_FAILED, RESUME_STATUS_READY, message, ...params);
  return info.changes;
}

/**
 * Prune old terminal agent runs. Active, pending, and resumable failed runs are
 * preserved; derived durable artifacts keep their content with run references
 * nulled where those references are soft links.
 */
export function pruneOldAgentRuns(
  retentionSeconds: number,
  scope: ProjectScope,
  nowSeconds = epochSeconds(),
): number {
  const db = getDatabase();
  const cutoff = nowSeconds - Math.max(0, retentionSeconds);
  const conditions = [
    'status IN (?, ?, ?)',
    'COALESCE(resumable, 0) = 0',
    'COALESCE(completed_at, started_at) IS NOT NULL',
    'COALESCE(completed_at, started_at) < ?',
  ];
  const params: unknown[] = [STATUS_COMPLETED, STATUS_FAILED, STATUS_SKIPPED, cutoff];
  appendProjectCondition(conditions, params, scope);

  const ids = db.prepare(
    `SELECT id FROM agent_runs WHERE ${conditions.join(' AND ')}`,
  ).all(...params).map((row) => (row as { id: string }).id);
  if (ids.length === 0) return 0;

  let deleted = 0;
  db.exec('BEGIN');
  try {
    forEachChunk(ids, 500, (chunk) => {
      const placeholders = chunk.map(() => '?').join(', ');
      db.prepare(
        `UPDATE digest_extract_revisions SET run_id = NULL WHERE run_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `UPDATE cortex_instructions SET source_run_id = NULL WHERE source_run_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `UPDATE canopy_maps SET generated_by_run_id = NULL WHERE generated_by_run_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `DELETE FROM agent_reports WHERE run_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `DELETE FROM agent_turns WHERE run_id IN (${placeholders})`,
      ).run(...chunk);
      db.prepare(
        `DELETE FROM agent_runs WHERE id IN (${placeholders})`,
      ).run(...chunk);
      deleted += chunk.length;
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return deleted;
}
