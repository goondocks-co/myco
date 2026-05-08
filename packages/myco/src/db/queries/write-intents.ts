/**
 * Write intent CRUD query helpers.
 *
 * A "write intent" is an append-only record of a write that a dry-run
 * agent attempted. Later tasks (tools.ts interceptor) will insert these
 * rows instead of performing the real write, so an operator can inspect
 * what a task would have done before committing.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 */

import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { epochSeconds } from '@myco/constants.js';
import { tryParseJson } from '@myco/utils/json.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required when inserting a write intent. */
export interface WriteIntentInsert {
  runId: string;
  projectId?: string | null;
  /** Phase of the task that emitted this write, if any. */
  phaseId?: string | null;
  /** Name of the tool the agent called (e.g. 'vault_create_spore'). */
  toolName: string;
  /** JSON-stringified arguments the agent called with. */
  toolInput: string;
  /** JSON-stringified stub payload returned to the agent. */
  syntheticOutput: string;
  /** Synthetic id minted for this call, if applicable. */
  stubId?: string | null;
  /** Override for the timestamp (defaults to `epochSeconds()`). */
  recordedAt?: number;
}

/**
 * Row shape returned from agent_run_write_intents queries.
 *
 * JSON-typed columns (`tool_input`, `synthetic_output`) are parsed back
 * into plain JS values on read, matching the convention used by
 * `evaluations.ts` (matrix_json → matrix). Parse failures degrade to
 * `null` rather than throwing so a corrupt row can't poison list queries.
 */
export interface WriteIntentRow {
  id: number;
  project_id: string | null;
  run_id: string;
  phase_id: string | null;
  tool_name: string;
  tool_input: unknown;
  synthetic_output: unknown;
  stub_id: string | null;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const INTENT_COLUMNS = [
  'id',
  'project_id',
  'run_id',
  'phase_id',
  'tool_name',
  'tool_input',
  'synthetic_output',
  'stub_id',
  'recorded_at',
] as const;

const SELECT_COLUMNS = INTENT_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toWriteIntentRow(row: Record<string, unknown>): WriteIntentRow {
  return {
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    run_id: row.run_id as string,
    phase_id: (row.phase_id as string) ?? null,
    tool_name: row.tool_name as string,
    tool_input: tryParseJson(row.tool_input),
    synthetic_output: tryParseJson(row.synthetic_output),
    stub_id: (row.stub_id as string) ?? null,
    recorded_at: row.recorded_at as number,
  };
}

export interface ListWriteIntentsOptions {
  limit?: number;
  offset?: number;
  scope: ProjectScope;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new write intent. Returns the autoincrement id.
 */
export function insertWriteIntent(data: WriteIntentInsert): number {
  const db = getDatabase();
  const recordedAt = data.recordedAt ?? epochSeconds();
  const info = db.prepare(
    `INSERT INTO agent_run_write_intents
       (project_id, run_id, phase_id, tool_name, tool_input, synthetic_output, stub_id, recorded_at)
     VALUES (COALESCE(?, (SELECT project_id FROM agent_runs WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    data.projectId ?? null,
    data.runId,
    data.runId,
    data.phaseId ?? null,
    data.toolName,
    data.toolInput,
    data.syntheticOutput,
    data.stubId ?? null,
    recordedAt,
  );
  return Number(info.lastInsertRowid);
}

/**
 * List every write intent for a run, ordered by id (= insert order).
 * Optional `limit` / `offset` for HTTP pagination; omit both for
 * backward-compatible "return everything" behavior.
 */
export function listWriteIntents(
  runId: string,
  options: ListWriteIntentsOptions,
): WriteIntentRow[] {
  const db = getDatabase();
  const conditions = ['run_id = ?'];
  const params: unknown[] = [runId];
  appendProjectCondition(conditions, params, options.scope);
  let tail = 'ORDER BY id ASC';
  if (options.limit !== undefined) {
    tail += ' LIMIT ?';
    params.push(options.limit);
    if (options.offset !== undefined) {
      tail += ' OFFSET ?';
      params.push(options.offset);
    }
  }
  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM agent_run_write_intents
     WHERE ${conditions.join(' AND ')}
     ${tail}`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(toWriteIntentRow);
}

/**
 * Row shape returned by {@link listWriteIntentTools} — id + metadata columns
 * only, no JSON payloads. Used by phase-audit where tool counts are all the
 * caller needs.
 */
export interface WriteIntentToolRow {
  id: number;
  project_id: string | null;
  run_id: string;
  phase_id: string | null;
  tool_name: string;
}

/**
 * Lightweight listing of write intents for a run: metadata columns only,
 * no JSON payload parsing. Preferred over {@link listWriteIntents} when
 * the caller only needs tool names / phase grouping.
 */
export function listWriteIntentTools(runId: string, scope: ProjectScope): WriteIntentToolRow[] {
  const db = getDatabase();
  const conditions = ['run_id = ?'];
  const params: unknown[] = [runId];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT id, project_id, run_id, phase_id, tool_name
     FROM agent_run_write_intents
     WHERE ${conditions.join(' AND ')}
     ORDER BY id ASC`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row.id as number,
    project_id: (row.project_id as string) ?? null,
    run_id: row.run_id as string,
    phase_id: (row.phase_id as string) ?? null,
    tool_name: row.tool_name as string,
  }));
}

/** Return the total number of write intents for a run. */
export function countWriteIntents(runId: string, scope: ProjectScope): number {
  const db = getDatabase();
  const conditions = ['run_id = ?'];
  const params: unknown[] = [runId];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT COUNT(*) AS count
     FROM agent_run_write_intents
     WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as { count: number };
  return Number(row.count);
}

/**
 * Count write intents grouped by tool name for a single run. Returned as a
 * plain object so callers can cheaply render summaries like "8 spores, 2
 * digest writes".
 */
export function countWriteIntentsByTool(runId: string, scope: ProjectScope): Record<string, number> {
  const db = getDatabase();
  const conditions = ['run_id = ?'];
  const params: unknown[] = [runId];
  appendProjectCondition(conditions, params, scope);
  const rows = db.prepare(
    `SELECT tool_name, COUNT(*) AS count
     FROM agent_run_write_intents
     WHERE ${conditions.join(' AND ')}
     GROUP BY tool_name`,
  ).all(...params) as Array<{ tool_name: string; count: number }>;

  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.tool_name] = Number(row.count);
  }
  return out;
}
