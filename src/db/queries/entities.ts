/**
 * Entity CRUD query helpers for the knowledge graph.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { getGraphForNode, type GraphEdgeRow } from '@myco/db/queries/graph-edges.js';

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
  agent_id: string;
  type: string;
  name: string;
  first_seen: number;
  last_seen: number;
  properties?: string | null;
}

/** Row shape returned from entity queries (all columns). */
export interface EntityRow {
  id: string;
  agent_id: string;
  type: string;
  name: string;
  properties: string | null;
  first_seen: number;
  last_seen: number;
  status: string;
}

/** Filter options for `listEntities`. */
export interface ListEntitiesOptions {
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

/** Return type for `getEntityWithEdges`. */
export interface EntityGraph {
  center: EntityRow;
  nodes: EntityRow[];
  edges: GraphEdgeRow[];
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS = [
  'id',
  'agent_id',
  'type',
  'name',
  'properties',
  'first_seen',
  'last_seen',
  'status',
] as const;

const SELECT_COLUMNS = ENTITY_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a SQLite result row into a typed EntityRow. */
function toEntityRow(row: Record<string, unknown>): EntityRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    type: row.type as string,
    name: row.name as string,
    properties: (row.properties as string) ?? null,
    first_seen: row.first_seen as number,
    last_seen: row.last_seen as number,
    status: (row.status as string) ?? 'active',
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert or update an entity. Uses UPSERT on (agent_id, type, name).
 *
 * On conflict, updates properties (if provided) and last_seen.
 */
export function insertEntity(data: EntityInsert): EntityRow {
  const db = getDatabase();

  db.prepare(
    `INSERT INTO entities (id, agent_id, type, name, properties, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_id, type, name) DO UPDATE SET
       properties = COALESCE(EXCLUDED.properties, entities.properties),
       last_seen = EXCLUDED.last_seen`,
  ).run(
    data.id,
    data.agent_id,
    data.type,
    data.name,
    data.properties ?? null,
    data.first_seen,
    data.last_seen,
  );

  // On conflict, the passed-in id may not be the actual row id. Look up by unique key.
  return toEntityRow(
    db.prepare(`SELECT ${SELECT_COLUMNS} FROM entities WHERE agent_id = ? AND type = ? AND name = ?`).get(
      data.agent_id,
      data.type,
      data.name,
    ) as Record<string, unknown>,
  );
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

/**
 * Fetch an entity and its surrounding graph via BFS traversal.
 *
 * Delegates to `getGraphForNode` (graph_edges table) for the BFS,
 * then fetches entity rows for all connected entity nodes.
 *
 * @param entityId - The center entity to expand from.
 * @param depth    - Number of hops to traverse (1-3, default 1).
 * @returns `{ center, nodes, edges }` where nodes are all connected entities
 *          (excluding center) and edges are deduplicated across BFS iterations.
 */
export function getEntityWithEdges(
  entityId: string,
  depth = 1,
): EntityGraph | null {
  const db = getDatabase();

  const center = getEntity(entityId);
  if (center === null) return null;

  const clampedDepth = Math.min(Math.max(depth, 1), 3);
  const graph = getGraphForNode(entityId, 'entity', { depth: clampedDepth });

  // Collect all entity node IDs from edges (excluding center)
  const nodeIdSet = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source_type === 'entity' && edge.source_id !== entityId) nodeIdSet.add(edge.source_id);
    if (edge.target_type === 'entity' && edge.target_id !== entityId) nodeIdSet.add(edge.target_id);
  }

  // Fetch all connected entity nodes
  const nodeIds = Array.from(nodeIdSet);
  let nodes: EntityRow[] = [];
  if (nodeIds.length > 0) {
    const placeholders = nodeIds.map(() => `?`).join(', ');
    const nodeRows = db.prepare(
      `SELECT ${SELECT_COLUMNS} FROM entities WHERE id IN (${placeholders})`,
    ).all(...nodeIds) as Record<string, unknown>[];
    nodes = nodeRows.map(toEntityRow);
  }

  return { center, nodes, edges: graph.edges };
}
