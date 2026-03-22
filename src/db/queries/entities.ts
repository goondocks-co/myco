/**
 * Entity CRUD query helpers for the knowledge graph.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

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
  curator_id: string;
  type: string;
  name: string;
  first_seen: number;
  last_seen: number;
  properties?: string | null;
}

/** Row shape returned from entity queries (all columns). */
export interface EntityRow {
  id: string;
  curator_id: string;
  type: string;
  name: string;
  properties: string | null;
  first_seen: number;
  last_seen: number;
}

/** Filter options for `listEntities`. */
export interface ListEntitiesOptions {
  curator_id?: string;
  type?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS = [
  'id',
  'curator_id',
  'type',
  'name',
  'properties',
  'first_seen',
  'last_seen',
] as const;

const SELECT_COLUMNS = ENTITY_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed EntityRow. */
function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    id: row.id as string,
    curator_id: row.curator_id as string,
    type: row.type as string,
    name: row.name as string,
    properties: (row.properties as string) ?? null,
    first_seen: row.first_seen as number,
    last_seen: row.last_seen as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert or update an entity. Uses UPSERT on (curator_id, type, name).
 *
 * On conflict, updates properties (if provided) and last_seen.
 */
export async function insertEntity(data: EntityInsert): Promise<EntityRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO entities (id, curator_id, type, name, properties, first_seen, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (curator_id, type, name) DO UPDATE SET
       properties = COALESCE(EXCLUDED.properties, entities.properties),
       last_seen = EXCLUDED.last_seen
     RETURNING ${SELECT_COLUMNS}`,
    [
      data.id,
      data.curator_id,
      data.type,
      data.name,
      data.properties ?? null,
      data.first_seen,
      data.last_seen,
    ],
  );

  return toEntityRow(result.rows[0] as Record<string, unknown>);
}

/**
 * Retrieve a single entity by id.
 *
 * @returns the entity row, or null if not found.
 */
export async function getEntity(id: string): Promise<EntityRow | null> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS} FROM entities WHERE id = $1`,
    [id],
  );

  if (result.rows.length === 0) return null;
  return toEntityRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List entities with optional filters, ordered by last_seen DESC.
 */
export async function listEntities(
  options: ListEntitiesOptions = {},
): Promise<EntityRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.curator_id !== undefined) {
    conditions.push(`curator_id = $${paramIndex++}`);
    params.push(options.curator_id);
  }

  if (options.type !== undefined) {
    conditions.push(`type = $${paramIndex++}`);
    params.push(options.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM entities
     ${where}
     ORDER BY last_seen DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toEntityRow);
}
