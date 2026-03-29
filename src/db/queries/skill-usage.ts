/**
 * Skill usage query helpers.
 *
 * Usage is append-only — each row records a detected use of a skill within
 * a session. No update path exists.
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

/** Default number of usage rows returned by listUsageForSkill when no limit given. */
export const DEFAULT_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a skill usage entry. */
export interface SkillUsageInsert {
  id: string;
  skill_id: string;
  session_id: string;
  machine_id?: string;
  detected_at: number;
}

/** Row shape returned from skill usage queries (all columns). */
export interface SkillUsageRow {
  id: string;
  skill_id: string;
  session_id: string;
  machine_id: string;
  detected_at: number;
}

/** Filter options for `listUsageForSkill`. */
export interface ListUsageOptions {
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

export const USAGE_COLUMNS = [
  'id',
  'skill_id',
  'session_id',
  'machine_id',
  'detected_at',
] as const;

const SELECT_COLUMNS = USAGE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed SkillUsageRow. */
function toUsageRow(row: Record<string, unknown>): SkillUsageRow {
  return {
    id: row.id as string,
    skill_id: row.skill_id as string,
    session_id: row.session_id as string,
    machine_id: (row.machine_id as string) ?? DEFAULT_MACHINE_ID,
    detected_at: row.detected_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new skill usage entry.
 *
 * Requires a valid `skill_id` (FK to skill_records) and `session_id` (FK to sessions).
 */
export function insertSkillUsage(data: SkillUsageInsert): SkillUsageRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO skill_usage (
       id, skill_id, session_id, machine_id, detected_at
     ) VALUES (
       ?, ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.skill_id,
    data.session_id,
    data.machine_id ?? DEFAULT_MACHINE_ID,
    data.detected_at,
  );

  const row = toUsageRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_usage WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );

  syncRow('skill_usage', row);

  return row;
}

/**
 * List usage entries for a skill, ordered by detected_at DESC.
 */
export function listUsageForSkill(
  skillId: string,
  options: ListUsageOptions = {},
): SkillUsageRow[] {
  const db = getDatabase();
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM skill_usage
     WHERE skill_id = ?
     ORDER BY detected_at DESC
     LIMIT ?`,
  ).all(skillId, limit) as Record<string, unknown>[];

  return rows.map(toUsageRow);
}

/**
 * Count total usage events for a skill.
 */
export function countUsageForSkill(skillId: string): number {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM skill_usage WHERE skill_id = ?`,
  ).get(skillId) as { count: number };

  return row.count;
}
