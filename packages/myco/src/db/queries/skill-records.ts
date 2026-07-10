/**
 * Skill record CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { getTeamMachineId } from '@myco/team/context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { appendProjectCondition, projectScopeClause, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { cancelActiveContentClaimForArtifact } from '@myco/db/queries/content-claims.js';


/** Default status for new skill records. */
const DEFAULT_STATUS = 'active';

/** Default generation for new skill records. */
const DEFAULT_GENERATION = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a skill record. */
export interface SkillRecordInsert {
  id: string;
  project_id?: string | null;
  agent_id: string;
  machine_id?: string;
  name: string;
  display_name: string;
  description: string;
  status?: string;
  generation?: number;
  candidate_id?: string | null;
  source_ids?: string;
  path: string;
  created_at: number;
  updated_at: number;
  properties?: string;
}

/** Fields that may be updated on a skill record. */
export interface SkillRecordUpdate {
  display_name?: string;
  description?: string;
  status?: string;
  generation?: number;
  source_ids?: string;
  path?: string;
  usage_count?: number;
  last_used_at?: number | null;
  updated_at: number;
  properties?: string;
}

/** Row shape returned from skill record queries (all columns). */
export interface SkillRecordRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  machine_id: string;
  name: string;
  display_name: string;
  description: string;
  status: string;
  generation: number;
  candidate_id: string | null;
  source_ids: string;
  path: string;
  usage_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  properties: string;
  synced_at: number | null;
}

/** Filter options for `listSkillRecords`. */
export interface ListSkillRecordsOptions {
  scope: ProjectScope;
  agent_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

export const RECORD_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'machine_id',
  'name',
  'display_name',
  'description',
  'status',
  'generation',
  'candidate_id',
  'source_ids',
  'path',
  'usage_count',
  'last_used_at',
  'created_at',
  'updated_at',
  'properties',
  'synced_at',
] as const;

const SELECT_COLUMNS = RECORD_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed SkillRecordRow. */
function toSkillRecordRow(row: Record<string, unknown>): SkillRecordRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    machine_id: (row.machine_id as string) ?? getTeamMachineId(),
    name: row.name as string,
    display_name: row.display_name as string,
    description: row.description as string,
    status: row.status as string,
    generation: row.generation as number,
    candidate_id: (row.candidate_id as string) ?? null,
    source_ids: (row.source_ids as string) ?? '[]',
    path: row.path as string,
    usage_count: row.usage_count as number,
    last_used_at: (row.last_used_at as number) ?? null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
    properties: (row.properties as string) ?? '{}',
    synced_at: (row.synced_at as number) ?? null,
  };
}

/** Build WHERE clause and bound params from skill record filter options. */
function buildWhere(
  options: Omit<ListSkillRecordsOptions, 'limit' | 'offset'>,
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

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new skill record.
 *
 * Requires a valid `agent_id` (foreign key to agents table).
 */
export function insertSkillRecord(data: SkillRecordInsert): SkillRecordRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO skill_records (
       id, project_id, agent_id, machine_id, name, display_name,
       description, status, generation, candidate_id,
       source_ids, path, created_at, updated_at, properties
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.project_id ?? null,
    data.agent_id,
    data.machine_id ?? getTeamMachineId(),
    data.name,
    data.display_name,
    data.description,
    data.status ?? DEFAULT_STATUS,
    data.generation ?? DEFAULT_GENERATION,
    data.candidate_id ?? null,
    data.source_ids ?? '[]',
    data.path,
    data.created_at,
    data.updated_at,
    data.properties ?? '{}',
  );

  const raw = db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_records WHERE id = ?`).get(data.id) as Record<string, unknown> | undefined;
  if (!raw) throw new Error(`Failed to insert skill record: ${data.id}`);
  const row = toSkillRecordRow(raw);

  syncRow('skill_records', row);

  return row;
}

/**
 * Retrieve a single skill record by id.
 *
 * @returns the skill record row, or null if not found.
 */
export function getSkillRecord(id: string, scope: ProjectScope): SkillRecordRow | null {
  const db = getDatabase();
  const conditions = ['id = ?'];
  const params: unknown[] = [id];
  appendProjectCondition(conditions, params, scope);

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM skill_records WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSkillRecordRow(row);
}

/**
 * Retrieve a single skill record by its unique name.
 *
 * @returns the skill record row, or null if not found.
 */
export function getSkillRecordByName(name: string, scope: ProjectScope): SkillRecordRow | null {
  const db = getDatabase();

  const conditions = ['name = ?'];
  const params: unknown[] = [name];
  appendProjectCondition(conditions, params, scope);
  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM skill_records WHERE ${conditions.join(' AND ')}`,
  ).get(...params) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSkillRecordRow(row);
}

/**
 * List skill records with optional filters, ordered by updated_at DESC.
 */
export function listSkillRecords(
  options: ListSkillRecordsOptions,
): SkillRecordRow[] {
  const db = getDatabase();
  const { where, params } = buildWhere(options);
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM skill_records
     ${where}
     ORDER BY updated_at DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(toSkillRecordRow);
}

/**
 * Update specific fields on an existing skill record.
 *
 * @returns the updated row, or null if the record does not exist.
 */
export function updateSkillRecord(
  id: string,
  updates: SkillRecordUpdate,
  scope: ProjectScope,
): SkillRecordRow | null {
  const db = getDatabase();

  const setClauses: string[] = [];
  const params: unknown[] = [];

  const fieldMap: Record<string, string> = {
    display_name: 'display_name',
    description: 'description',
    status: 'status',
    generation: 'generation',
    source_ids: 'source_ids',
    path: 'path',
    usage_count: 'usage_count',
    last_used_at: 'last_used_at',
    updated_at: 'updated_at',
    properties: 'properties',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    if (key in updates) {
      setClauses.push(`${column} = ?`);
      params.push((updates as unknown as Record<string, unknown>)[key] ?? null);
    }
  }

  if (setClauses.length === 0) return getSkillRecord(id, scope);

  params.push(id);
  const conditions = ['id = ?'];
  appendProjectCondition(conditions, params, scope);

  db.prepare(
    `UPDATE skill_records
     SET ${setClauses.join(', ')}
     WHERE ${conditions.join(' AND ')}`,
  ).run(...params);

  const updated = getSkillRecord(id, scope);

  if (updated) syncRow('skill_records', updated);

  return updated;
}

/**
 * Atomically increment the usage_count for a skill record and update last_used_at.
 *
 * Uses a direct SQL increment (`usage_count + 1`) to avoid read-modify-write
 * races when multiple detections could run concurrently.
 */
export function incrementSkillUsageCount(id: string, now: number): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE skill_records SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, now, id);
  // Note: syncRow omitted for atomic increment — synced via next full record read
}

/**
 * List skill records and return the total count in a single call.
 *
 * Runs listSkillRecords and countSkillRecords with the same filter options.
 * Saves callers from issuing two separate function calls.
 */
export function listSkillRecordsWithCount(
  options: ListSkillRecordsOptions,
): { items: SkillRecordRow[]; total: number } {
  const items = listSkillRecords(options);
  const total = countSkillRecords(options);
  return { items, total };
}

/**
 * Count skill records matching optional filters (for pagination totals).
 */
export function countSkillRecords(
  options: Omit<ListSkillRecordsOptions, 'limit' | 'offset'>,
): number {
  const db = getDatabase();
  const { where, params } = buildWhere(options);

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM skill_records ${where}`,
  ).get(...params) as { count: number };

  return row.count;
}

/**
 * Delete a skill record and cascade to lineage, usage, and linked candidates.
 * Runs in a transaction, and also cancels the artifact's active content
 * claim (if any) in the same transaction — the delete flow's explicit
 * cancel, not an FK cascade (content-claim spec §5). Both skill-DELETE
 * paths (the agent tool and the daemon API) call this one function, so the
 * cancel fires for either caller without duplicating the logic at each
 * call site. Does NOT handle disk/symlink cleanup — callers must handle
 * filesystem operations separately.
 *
 * @returns the deleted record's name (for disk cleanup) or null if not found.
 */
export function deleteSkillRecordCascade(
  idOrName: string,
  scope: ProjectScope,
): { id: string; project_id: string | null; name: string } | null {
  const db = getDatabase();
  const record = getSkillRecord(idOrName, scope) ?? getSkillRecordByName(idOrName, scope);
  if (!record) return null;
  const candidateScope = projectScopeClause(scope);
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    db.prepare('DELETE FROM skill_lineage WHERE skill_id = ?').run(record.id);
    db.prepare('DELETE FROM skill_usage WHERE skill_id = ?').run(record.id);
    // Dismiss linked candidates so they don't regenerate
    if (record.candidate_id) {
      db.prepare(
        `UPDATE skill_candidates SET status = 'dismissed', skill_id = NULL, updated_at = ? WHERE id = ?${candidateScope.sql}`,
      ).run(now, record.candidate_id, ...candidateScope.params);
    }
    db.prepare(
      `UPDATE skill_candidates SET status = 'dismissed', skill_id = NULL, updated_at = ? WHERE skill_id = ?${candidateScope.sql}`,
    ).run(now, record.id, ...candidateScope.params);
    db.prepare('DELETE FROM skill_records WHERE id = ?').run(record.id);
    cancelActiveContentClaimForArtifact('skill', record.id, now);
  })();

  return { id: record.id, project_id: record.project_id, name: record.name };
}
