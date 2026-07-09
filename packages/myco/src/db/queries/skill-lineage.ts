/**
 * Skill lineage query helpers.
 *
 * Lineage is append-only (no update). Each row records a generation event
 * for a skill — what changed, why, and a snapshot of the content at that
 * point in time.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { appendProjectCondition, type ProjectScope } from '@myco/db/queries/project-scope.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';
import { getTeamMachineId } from '@myco/team/context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting a skill lineage entry. */
export interface LineageInsert {
  id: string;
  project_id?: string | null;
  skill_id: string;
  generation: number;
  action: string;
  rationale: string;
  source_ids_added?: string;
  content_snapshot: string;
  created_at: number;
  machine_id?: string;
}

/** Row shape returned from skill lineage queries (all columns). */
export interface LineageRow {
  id: string;
  project_id: string | null;
  skill_id: string;
  generation: number;
  action: string;
  rationale: string;
  source_ids_added: string;
  content_snapshot: string;
  created_at: number;
  machine_id: string;
  synced_at: number | null;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

export const LINEAGE_COLUMNS = [
  'id',
  'project_id',
  'skill_id',
  'generation',
  'action',
  'rationale',
  'source_ids_added',
  'content_snapshot',
  'created_at',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = LINEAGE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed LineageRow. */
function toLineageRow(row: Record<string, unknown>): LineageRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    skill_id: row.skill_id as string,
    generation: row.generation as number,
    action: row.action as string,
    rationale: row.rationale as string,
    source_ids_added: (row.source_ids_added as string) ?? '[]',
    content_snapshot: row.content_snapshot as string,
    created_at: row.created_at as number,
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new skill lineage entry and enqueue it for team sync — lineage
 * carries the skill's full content history, so it must reach every member's
 * replica just like the head record.
 * Requires a valid `skill_id` (foreign key to skill_records table).
 */
export function insertLineage(data: LineageInsert): LineageRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO skill_lineage (
       id, project_id, skill_id, generation, action, rationale,
       source_ids_added, content_snapshot, created_at, machine_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    data.id,
    data.project_id ?? null,
    data.skill_id,
    data.generation,
    data.action,
    data.rationale,
    data.source_ids_added ?? '[]',
    data.content_snapshot,
    data.created_at,
    data.machine_id ?? getTeamMachineId(),
  );

  const row = toLineageRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM skill_lineage WHERE id = ?`).get(data.id) as Record<string, unknown>,
  );
  syncRow('skill_lineage', row);
  return row;
}

/**
 * List all lineage entries for a skill, ordered by generation DESC
 * (newest generation first).
 */
export function listLineageForSkill(
  skillId: string,
  scope: ProjectScope,
  limit = 50,
): LineageRow[] {
  const db = getDatabase();
  const conditions = ['skill_id = ?'];
  const params: unknown[] = [skillId];
  appendProjectCondition(conditions, params, scope);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM skill_lineage
     WHERE ${conditions.join(' AND ')}
     ORDER BY generation DESC
     LIMIT ?`,
  ).all(...params, limit) as Record<string, unknown>[];

  return rows.map(toLineageRow);
}
