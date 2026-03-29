/**
 * Skill record CRUD query helpers.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of records returned by listSkillRecords when no limit given. */
export const DEFAULT_LIST_LIMIT = 50;

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
    agent_id: row.agent_id as string,
    machine_id: (row.machine_id as string) ?? DEFAULT_MACHINE_ID,
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
       id, agent_id, machine_id, name, display_name,
       description, status, generation, candidate_id,
       source_ids, path, created_at, updated_at, properties
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.agent_id,
    data.machine_id ?? DEFAULT_MACHINE_ID,
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

  const row = toSkillRecordRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_records WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('skill_records', row);

  return row;
}

/**
 * Retrieve a single skill record by id.
 *
 * @returns the skill record row, or null if not found.
 */
export function getSkillRecord(id: string): SkillRecordRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM skill_records WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSkillRecordRow(row);
}

/**
 * Retrieve a single skill record by its unique name.
 *
 * @returns the skill record row, or null if not found.
 */
export function getSkillRecordByName(name: string): SkillRecordRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM skill_records WHERE name = ?`,
  ).get(name) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toSkillRecordRow(row);
}

/**
 * List skill records with optional filters, ordered by updated_at DESC.
 */
export function listSkillRecords(
  options: ListSkillRecordsOptions = {},
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

  if (setClauses.length === 0) return getSkillRecord(id);

  params.push(id);

  db.prepare(
    `UPDATE skill_records
     SET ${setClauses.join(', ')}
     WHERE id = ?`,
  ).run(...params);

  const updated = getSkillRecord(id);

  if (updated) syncRow('skill_records', updated);

  return updated;
}

/**
 * Count skill records matching optional filters (for pagination totals).
 */
export function countSkillRecords(
  options: Omit<ListSkillRecordsOptions, 'limit' | 'offset'> = {},
): number {
  const db = getDatabase();
  const { where, params } = buildWhere(options);

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM skill_records ${where}`,
  ).get(...params) as { count: number };

  return row.count;
}
