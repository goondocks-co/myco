/**
 * Skill candidate CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';


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
  approved_at?: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Fields that may be updated on a skill candidate.
 *
 * `approved_at` is normally auto-managed by `updateCandidate` on first
 * transition into `'approved'` — callers should not set it manually.
 * It is exposed here so the backfill migration and tests can seed it.
 */
export interface CandidateUpdate {
  topic?: string;
  rationale?: string;
  confidence?: number;
  status?: string;
  source_ids?: string;
  skill_id?: string | null;
  approved_at?: number | null;
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
  approved_at: number | null;
  created_at: number;
  updated_at: number;
  synced_at: number | null;
}

/** Filter options for `listCandidates`. */
export interface ListCandidatesOptions {
  agent_id?: string;
  /** Exact-match status filter. Ignored when `statuses` is provided. */
  status?: string;
  /**
   * Multi-status filter emitted as `status IN (?, ?, ...)`. Takes
   * precedence over `status` when both are set. An empty array is
   * treated as "no filter" so REST callers can forward user input
   * without branching.
   */
  statuses?: string[];
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
  'approved_at',
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
    machine_id: (row.machine_id as string) ?? getTeamMachineId(),
    topic: row.topic as string,
    rationale: row.rationale as string,
    confidence: row.confidence as number,
    status: row.status as string,
    source_ids: (row.source_ids as string) ?? '[]',
    skill_id: (row.skill_id as string) ?? null,
    approved_at: (row.approved_at as number) ?? null,
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

  // Multi-status wins over single-status when both are provided. Empty
  // array is treated as "no status filter" so REST handlers can forward
  // user input without branching on presence.
  if (options.statuses !== undefined && options.statuses.length > 0) {
    const placeholders = options.statuses.map(() => '?').join(', ');
    conditions.push(`status IN (${placeholders})`);
    params.push(...options.statuses);
  } else if (options.status !== undefined) {
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
       confidence, status, source_ids, skill_id, approved_at,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    data.id,
    data.agent_id,
    data.machine_id ?? getTeamMachineId(),
    data.topic,
    data.rationale,
    data.confidence ?? DEFAULT_CONFIDENCE,
    data.status ?? DEFAULT_STATUS,
    data.source_ids ?? '[]',
    data.skill_id ?? null,
    data.approved_at ?? null,
    data.created_at,
    data.updated_at,
  );

  const raw = db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_candidates WHERE id = ?`).get(data.id) as Record<string, unknown> | undefined;
  if (!raw) throw new Error(`Failed to insert skill candidate: ${data.id}`);
  const row = toCandidateRow(raw);

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

  // Auto-manage approved_at: stamp on the FIRST transition into 'approved'
  // and never overwrite thereafter. Single audit trail source of truth —
  // callers should not set approved_at directly (the field is exposed on
  // CandidateUpdate only so the backfill migration and tests can seed it).
  //
  // Compute the auto-stamped value as a local, then fold it into the
  // fieldMap iteration below alongside the caller-supplied fields. No
  // defensive clone of `updates` needed.
  let autoApprovedAt: number | undefined;
  if (
    updates.status === 'approved' &&
    updates.approved_at === undefined
  ) {
    const existing = getCandidate(id);
    if (existing && existing.approved_at === null) {
      autoApprovedAt = updates.updated_at;
    }
  }

  const fieldMap: Record<string, string> = {
    topic: 'topic',
    rationale: 'rationale',
    confidence: 'confidence',
    status: 'status',
    source_ids: 'source_ids',
    skill_id: 'skill_id',
    approved_at: 'approved_at',
    updated_at: 'updated_at',
  };

  const setClauses: string[] = [];
  const params: unknown[] = [];
  const updateValues = updates as unknown as Record<string, unknown>;

  for (const [key, column] of Object.entries(fieldMap)) {
    if (key in updates) {
      setClauses.push(`${column} = ?`);
      params.push(updateValues[key] ?? null);
    } else if (key === 'approved_at' && autoApprovedAt !== undefined) {
      setClauses.push(`${column} = ?`);
      params.push(autoApprovedAt);
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
 * List candidates and return the unpaginated total count in a single
 * SQL round-trip. The `COUNT(*) OVER ()` window function computes the
 * total against the full filter set, and then `LIMIT`/`OFFSET` clip
 * the result set — so `total` always reflects the count before
 * pagination, matching the two-query implementation this replaces.
 *
 * When the filter matches zero rows, the result set is empty and we
 * fall back to a bare COUNT query for the total. In practice this is
 * a fast index lookup and happens only on empty pages.
 */
export function listCandidatesWithCount(
  options: ListCandidatesOptions = {},
): { items: CandidateRow[]; total: number } {
  const db = getDatabase();
  const { where, params } = buildWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}, COUNT(*) OVER () AS __total
     FROM skill_candidates
     ${where}
     ORDER BY confidence DESC, created_at DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Array<Record<string, unknown> & { __total: number }>;

  if (rows.length === 0) {
    // Empty page — fall back to COUNT for the total. This keeps
    // callers that query beyond the last page (offset > total) from
    // losing visibility into the true count.
    return { items: [], total: countCandidates(options) };
  }

  const total = Number(rows[0].__total);
  const items = rows.map((row) => {
    // Strip the window-function column before the row mapper sees it.
    const { __total: _drop, ...rest } = row;
    return toCandidateRow(rest);
  });
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

/**
 * Delete a skill candidate by id.
 *
 * @returns true if a row was deleted, false if not found.
 */
export function deleteCandidate(id: string): boolean {
  const db = getDatabase();
  const info = db.prepare('DELETE FROM skill_candidates WHERE id = ?').run(id);
  return info.changes > 0;
}
