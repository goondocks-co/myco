/**
 * Agent run CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
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
 */
const UPDATE_COLUMNS: readonly (keyof RunUpdate)[] = [
  'status',
  'task',
  'instruction',
  'harness',
  'provider',
  'model',
  'session_ref',
  'started_at',
  'resumable',
  'resume_status',
  'resume_mode',
  'resumed_at',
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function insertRun(data: RunInsert): RunRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO agent_runs (
       id, project_id, agent_id, task, instruction, status,
       harness, provider, model, session_ref, resumable,
       resume_status, resume_mode, resumed_at, checkpoints, usage_data,
       started_at, completed_at, tokens_used, cost_usd,
       actual_cost_usd, estimated_cost_usd, cost_source, cost_data,
       actions_taken, error, dry_run,
       reasoning_level, execution_overrides
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?,
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

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     ${where}
     ORDER BY started_at DESC NULLS LAST
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

export function getRunningRun(agentId: string, scope: ProjectScope): RunRow | null {
  const db = getDatabase();
  const conditions = ['agent_id = ?', 'status = ?'];
  const params: unknown[] = [agentId, STATUS_RUNNING];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1`,
  ).get(...params) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export function getRunningRunForTask(
  agentId: string,
  taskName: string,
  scope: ProjectScope,
): string | null {
  const db = getDatabase();
  const conditions = ['agent_id = ?', 'task = ?', 'status = ?'];
  const params: unknown[] = [agentId, taskName, STATUS_RUNNING];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT id FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
  ).get(...params) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getLatestRunId(
  agentId: string,
  taskName: string | undefined,
  scope: ProjectScope,
): string | null {
  const db = getDatabase();
  const conditions = ['agent_id = ?'];
  const params: unknown[] = [agentId];
  if (taskName) {
    conditions.push('task = ?');
    params.push(taskName);
  }
  appendProjectCondition(conditions, params, scope);

  const row = db.prepare(
    `SELECT id FROM agent_runs
     WHERE ${conditions.join(' AND ')}
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(...params) as { id: string } | undefined;
  return row?.id ?? null;
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
