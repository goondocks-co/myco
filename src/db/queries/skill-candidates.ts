/**
 * Skill candidate CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_MACHINE_ID, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

// Re-export for callers that import DEFAULT_LIST_LIMIT from this module
export { DEFAULT_LIST_LIMIT };

/** Default confidence score for new candidates. */
const DEFAULT_CONFIDENCE = 0.0;

/** Default status for new candidates. */
const DEFAULT_STATUS = 'identified';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a skill candidate. */
export interface CandidateInsert {
  id: string;
  agent_id: string;
  machine_id?: string;
  topic: string;
  rationale: string;
  confidence?: number;
  status?: string;
  source_ids?: string;
  skill_id?: string | null;
  created_at: number;
  updated_at: number;
}

/** Fields that may be updated on a skill candidate. */
export interface CandidateUpdate {
  topic?: string;
  rationale?: string;
  confidence?: number;
  status?: string;
  source_ids?: string;
  skill_id?: string | null;
  updated_at: number;
}

/** Row shape returned from skill candidate queries (all columns). */
export interface CandidateRow {
  id: string;
  agent_id: string;
  machine_id: string;
  topic: string;
  rationale: string;
  confidence: number;
  status: string;
  source_ids: string;
  skill_id: string | null;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
}

/** Filter options for `listCandidates`. */
export interface ListCandidatesOptions {
  agent_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

export const CANDIDATE_COLUMNS = [
  'id',
  'agent_id',
  'machine_id',
  'topic',
  'rationale',
  'confidence',
  'status',
  'source_ids',
  'skill_id',
  'created_at',
  'updated_at',
  'synced_at',
] as const;

const SELECT_COLUMNS = CANDIDATE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed CandidateRow. */
function toCandidateRow(row: Record<string, unknown>): CandidateRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    machine_id: (row.machine_id as string) ?? DEFAULT_MACHINE_ID,
    topic: row.topic as string,
    rationale: row.rationale as string,
    confidence: row.confidence as number,
    status: row.status as string,
    source_ids: (row.source_ids as string) ?? '[]',
    skill_id: (row.skill_id as string) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    synced_at: (row.synced_at as number) ?? null,
  };
}

/** Build WHERE clause and bound params from candidate filter options. */
function buildWhere(
  options: Omit<ListCandidatesOptions, 'limit' | 'offset'>,
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

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new skill candidate.
 *
 * Requires a valid `agent_id` (foreign key to agents table).
 */
export function insertCandidate(data: CandidateInsert): CandidateRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO skill_candidates (
       id, agent_id, machine_id, topic, rationale,
       confidence, status, source_ids, skill_id,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    data.id,
    data.agent_id,
    data.machine_id ?? DEFAULT_MACHINE_ID,
    data.topic,
    data.rationale,
    data.confidence ?? DEFAULT_CONFIDENCE,
    data.status ?? DEFAULT_STATUS,
    data.source_ids ?? '[]',
    data.skill_id ?? null,
    data.created_at,
    data.updated_at,
  );

  const row = toCandidateRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_candidates WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('skill_candidates', row);

  return row;
}

/**
 * Retrieve a single skill candidate by id.
 *
 * @returns the candidate row, or null if not found.
 */
export function getCandidate(id: string): CandidateRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM skill_candidates WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toCandidateRow(row);
}

/**
 * List skill candidates with optional filters, ordered by confidence DESC,
 * created_at DESC.
 */
export function listCandidates(
  options: ListCandidatesOptions = {},
): CandidateRow[] {
  const db = getDatabase();
  const { where, params } = buildWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM skill_candidates
     ${where}
     ORDER BY confidence DESC, created_at DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(toCandidateRow);
}

/**
 * Update specific fields on an existing skill candidate.
 *
 * @returns the updated row, or null if the candidate does not exist.
 */
export function updateCandidate(
  id: string,
  updates: CandidateUpdate,
): CandidateRow | null {
  const db = getDatabase();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const fieldMap: Record<string, string> = {
    topic: 'topic',
    rationale: 'rationale',
    confidence: 'confidence',
    status: 'status',
    source_ids: 'source_ids',
    skill_id: 'skill_id',
    updated_at: 'updated_at',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    if (key in updates) {
      setClauses.push(`${column} = ?`);
      params.push((updates as unknown as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) return getCandidate(id);

  params.push(id);

  db.prepare(
    `UPDATE skill_candidates
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
  ).run(...params);

  const updated = getCandidate(id);

  if (updated) syncRow('skill_candidates', updated);

  return updated;
}

/**
 * List candidates and return the total count in a single call.
 *
 * Runs listCandidates and countCandidates with the same filter options.
 * Saves callers from issuing two separate function calls.
 */
export function listCandidatesWithCount(
  options: ListCandidatesOptions = {},
): { items: CandidateRow[]; total: number } {
  const items = listCandidates(options);
  const total = countCandidates(options);
  return { items, total };
}

/**
 * Count skill candidates matching optional filters (for pagination totals).
 */
export function countCandidates(
  options: Omit<ListCandidatesOptions, 'limit' | 'offset'> = {},
): number {
  const db = getDatabase();
  const { where, params } = buildWhere(options);

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM skill_candidates ${where}`,
  ).get(...params) as { count: number };

  return row.count;
}
