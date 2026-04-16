/**
 * Agent run CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import type { ProviderType, RuntimeId } from '@myco/agent/types.js';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunInsert {
  id: string;
  agent_id: string;
  task?: string | null;
  instruction?: string | null;
  status?: string;
  runtime?: RuntimeId | null;
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
}

export interface RunRow {
  id: string;
  agent_id: string;
  task: string | null;
  instruction: string | null;
  status: string;
  runtime: RuntimeId | null;
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
}

export interface RunUpdate {
  status?: string;
  runtime?: RuntimeId | null;
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
}

export interface RunCompletion extends RunUpdate {
  completed_at?: number;
  tokens_used?: number;
  cost_usd?: number | null;
  actual_cost_usd?: number | null;
  estimated_cost_usd?: number | null;
  cost_source?: CostSource | null;
  cost_data?: string | null;
  actions_taken?: string;
  error?: string;
}

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
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
  'agent_id',
  'task',
  'instruction',
  'status',
  'runtime',
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
] as const;

const SELECT_COLUMNS = RUN_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    task: (row.task as string) ?? null,
    instruction: (row.instruction as string) ?? null,
    status: row.status as string,
    runtime: (row.runtime as RuntimeId) ?? null,
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
    cost_source: (row.cost_source as CostSource) ?? null,
    cost_data: (row.cost_data as string) ?? null,
    actions_taken: (row.actions_taken as string) ?? null,
    error: (row.error as string) ?? null,
  };
}

function buildRunsWhere(
  options: Omit<ListRunsOptions, 'limit' | 'offset'>,
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

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

function buildUpdateClauses(update: RunUpdate): { setClauses: string[]; params: unknown[] } {
  const mappings: Array<{ key: keyof RunUpdate; column: string }> = [
    { key: 'status', column: 'status' },
    { key: 'runtime', column: 'runtime' },
    { key: 'provider', column: 'provider' },
    { key: 'model', column: 'model' },
    { key: 'session_ref', column: 'session_ref' },
    { key: 'started_at', column: 'started_at' },
    { key: 'resumable', column: 'resumable' },
    { key: 'resume_status', column: 'resume_status' },
    { key: 'resume_mode', column: 'resume_mode' },
    { key: 'resumed_at', column: 'resumed_at' },
    { key: 'checkpoints', column: 'checkpoints' },
    { key: 'usage_data', column: 'usage_data' },
    { key: 'completed_at', column: 'completed_at' },
    { key: 'tokens_used', column: 'tokens_used' },
    { key: 'cost_usd', column: 'cost_usd' },
    { key: 'actual_cost_usd', column: 'actual_cost_usd' },
    { key: 'estimated_cost_usd', column: 'estimated_cost_usd' },
    { key: 'cost_source', column: 'cost_source' },
    { key: 'cost_data', column: 'cost_data' },
    { key: 'actions_taken', column: 'actions_taken' },
    { key: 'error', column: 'error' },
  ];

  const setClauses: string[] = [];
  const params: unknown[] = [];

  for (const { key, column } of mappings) {
    if (key in update) {
      setClauses.push(`${column} = ?`);
      params.push(update[key]);
    }
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
       id, agent_id, task, instruction, status,
       runtime, provider, model, session_ref, resumable,
       resume_status, resume_mode, resumed_at, checkpoints, usage_data,
       started_at, completed_at, tokens_used, cost_usd,
       actual_cost_usd, estimated_cost_usd, cost_source, cost_data,
       actions_taken, error
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    data.id,
    data.agent_id,
    data.task ?? null,
    data.instruction ?? null,
    data.status ?? DEFAULT_STATUS,
    data.runtime ?? null,
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
  );

  return getRun(data.id)!;
}

export function getRun(id: string): RunRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM agent_runs WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export function listRuns(options: ListRunsOptions = {}): RunRow[] {
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
  options: Omit<ListRunsOptions, 'limit' | 'offset'> = {},
): number {
  const db = getDatabase();
  const { where, params } = buildRunsWhere(options);
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM agent_runs ${where}`,
  ).get(...params) as { count: number };
  return row.count;
}

export function updateRun(id: string, update: RunUpdate): RunRow | null {
  const db = getDatabase();
  const { setClauses, params } = buildUpdateClauses(update);
  if (setClauses.length === 0) return getRun(id);

  params.push(id);
  const info = db.prepare(
    `UPDATE agent_runs
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
  ).run(...params);

  if (info.changes === 0) return null;
  return getRun(id);
}

export function updateRunStatus(
  id: string,
  status: string,
  completion?: RunCompletion,
): RunRow | null {
  return updateRun(id, { status, ...completion });
}

export function getRunningRun(agentId: string): RunRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE agent_id = ? AND status = ?
     ORDER BY started_at DESC NULLS LAST
     LIMIT 1`,
  ).get(agentId, STATUS_RUNNING) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export function getRunningRunForTask(
  agentId: string,
  taskName: string,
): string | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT id FROM agent_runs
     WHERE agent_id = ? AND task = ? AND status = ?
     LIMIT 1`,
  ).get(agentId, taskName, STATUS_RUNNING) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getLatestRunId(
  agentId: string,
  taskName?: string,
): string | null {
  const db = getDatabase();

  if (taskName) {
    const row = db.prepare(
      `SELECT id FROM agent_runs
       WHERE agent_id = ? AND task = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    ).get(agentId, taskName) as { id: string } | undefined;
    return row?.id ?? null;
  }

  const row = db.prepare(
    `SELECT id FROM agent_runs
     WHERE agent_id = ?
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function getLatestResumableRunForTask(
  agentId: string,
  taskName: string,
): RunRow | null {
  const db = getDatabase();
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_runs
     WHERE agent_id = ?
       AND task = ?
       AND resumable = 1
       AND status = ?
     ORDER BY completed_at DESC NULLS LAST, started_at DESC NULLS LAST
     LIMIT 1`,
  ).get(agentId, taskName, STATUS_FAILED) as Record<string, unknown> | undefined;
  return row ? toRunRow(row) : null;
}

export function markRunningRunsInterrupted(message: string): number {
  const db = getDatabase();
  const info = db.prepare(
    `UPDATE agent_runs
     SET status = ?,
         resumable = 1,
         resume_status = ?,
         error = COALESCE(error, ?)
     WHERE status = ?`,
  ).run(STATUS_FAILED, RESUME_STATUS_READY, message, STATUS_RUNNING);
  return info.changes;
}
