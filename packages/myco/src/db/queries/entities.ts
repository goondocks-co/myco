/**
 * Entity CRUD query helpers for the knowledge graph.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { getTeamMachineId } from '@myco/daemon/team-context.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of entities returned by listEntities when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting an entity. */
export interface EntityInsert {
  id: string;
  project_id?: string | null;
  agent_id: string;
  type: string;
  name: string;
  first_seen: number;
  last_seen: number;
  properties?: string | null;
  machine_id?: string;
}

/** Row shape returned from entity queries (all columns). */
export interface EntityRow {
  id: string;
  project_id: string | null;
  agent_id: string;
  type: string;
  name: string;
  properties: string | null;
  first_seen: number;
  last_seen: number;
  status: string;
  machine_id: string;
  synced_at: number | null;
}

/** Filter options for `listEntities`. */
export interface ListEntitiesOptions {
  project_id?: string | null;
  agent_id?: string;
  type?: string;
  /** Filter by exact entity name. */
  name?: string;
  /** Filter by status (default 'active'). */
  status?: string;
  /** Filter by entity_mentions subquery — must be paired with note_type. */
  mentioned_in?: string;
  /** Required when mentioned_in is provided. */
  note_type?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS = [
  'id',
  'project_id',
  'agent_id',
  'type',
  'name',
  'properties',
  'first_seen',
  'last_seen',
  'status',
  'machine_id',
  'synced_at',
] as const;

const SELECT_COLUMNS = ENTITY_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed EntityRow. */
function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    id: row.id as string,
    project_id: (row.project_id as string) ?? null,
    agent_id: row.agent_id as string,
    type: row.type as string,
    name: row.name as string,
    properties: (row.properties as string) ?? null,
    first_seen: row.first_seen as number,
    last_seen: row.last_seen as number,
    status: (row.status as string) ?? 'active',
    machine_id: (row.machine_id as string) ?? 'local',
    synced_at: (row.synced_at as number) ?? null,
  };
}

function normalizeProjectId(projectId: string | null | undefined): string | null {
  return projectId ?? null;
}

function entityIdentityWhere(projectId: string | null): { where: string; params: unknown[] } {
  return projectId === null
    ? { where: 'project_id IS NULL AND agent_id = ? AND type = ? AND name = ?', params: [] }
    : { where: 'project_id = ? AND agent_id = ? AND type = ? AND name = ?', params: [projectId] };
}

function entityIdentityParams(
  projectId: string | null,
  agentId: string,
  type: string,
  name: string,
): unknown[] {
  const { params } = entityIdentityWhere(projectId);
  return [...params, agentId, type, name];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert or update an entity by project-scoped (agent_id, type, name).
 *
 * On conflict, updates properties (if provided) and last_seen.
 */
export function insertEntity(data: EntityInsert): EntityRow {
  const db = getDatabase();
  const projectId = normalizeProjectId(data.project_id);
  const identity = entityIdentityWhere(projectId);
  const identityParams = entityIdentityParams(projectId, data.agent_id, data.type, data.name);

  const existing = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM entities WHERE ${identity.where}`,
  ).get(...identityParams) as Record<string, unknown> | undefined;

  if (existing) {
    db.prepare(
      `UPDATE entities
       SET properties = COALESCE(?, properties),
           last_seen = ?
       WHERE id = ?`,
    ).run(data.properties ?? null, data.last_seen, existing.id);
  } else {
    db.prepare(
      `INSERT INTO entities (id, project_id, agent_id, type, name, properties, first_seen, last_seen, machine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.id,
      projectId,
      data.agent_id,
      data.type,
      data.name,
      data.properties ?? null,
      data.first_seen,
      data.last_seen,
      data.machine_id ?? getTeamMachineId(),
    );
  }

  // On update, the passed-in id may not be the actual row id. Look up by unique key.
  const row = toEntityRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM entities WHERE ${identity.where}`).get(
      ...identityParams,
    ) as Record<string, unknown>,
  );

  syncRow('entities', row);

  return row;
}

/**
 * Retrieve a single entity by id.
 *
 * @returns the entity row, or null if not found.
 */
export function getEntity(id: string): EntityRow | null {
  const db = getDatabase();

  const row = db.prepare(
    `SELECT ${SELECT_COLUMNS} FROM entities WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return toEntityRow(row);
}

/**
 * List entities with optional filters, ordered by last_seen DESC.
 *
 * Defaults to `status = 'active'` — archived entities are excluded unless
 * `status` is explicitly provided. Pass `status: undefined` in options to
 * get only active entities (the default), or set a specific status string.
 *
 * When both `mentioned_in` and `note_type` are provided, filters to entities
 * referenced in a specific note via the entity_mentions subquery.
 */
export function listEntities(
  options: ListEntitiesOptions = {},
): EntityRow[] {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options.project_id !== undefined) {
    if (options.project_id === null) {
      conditions.push(`project_id IS NULL`);
    } else {
      conditions.push(`project_id = ?`);
      params.push(options.project_id);
    }
  }

  if (options.agent_id !== undefined) {
    conditions.push(`agent_id = ?`);
    params.push(options.agent_id);
  }

  if (options.type !== undefined) {
    conditions.push(`type = ?`);
    params.push(options.type);
  }

  if (options.name !== undefined) {
    conditions.push(`name = ?`);
    params.push(options.name);
  }

  // Default: only show active entities (status column added in v5)
  if (options.status !== undefined) {
    conditions.push(`status = ?`);
    params.push(options.status);
  } else {
    conditions.push(`status = ?`);
    params.push('active');
  }

  if (options.mentioned_in !== undefined && options.note_type !== undefined) {
    conditions.push(
      `id IN (SELECT entity_id FROM entity_mentions WHERE note_id = ? AND note_type = ?)`,
    );
    params.push(options.mentioned_in);
    params.push(options.note_type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;
  const offset = options.offset ?? 0;

  params.push(limit);
  params.push(offset);

  const rows = db.prepare(
    `SELECT ${SELECT_COLUMNS}
     FROM entities
     ${where}
     ORDER BY last_seen DESC
     LIMIT ?
     OFFSET ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(toEntityRow);
}
