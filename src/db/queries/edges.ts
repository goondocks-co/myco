/**
 * Edge CRUD query helpers for the knowledge graph.
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 * Queries use parameterized placeholders ($1, $2, ...) throughout.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of edges returned by listEdges when no limit given. */
const DEFAULT_LIST_LIMIT = 100;

/** Default confidence score for new edges. */
const DEFAULT_CONFIDENCE = 1.0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Fields required (or optional) when inserting an edge. */
export interface EdgeInsert {
  curator_id: string;
  source_id: string;
  target_id: string;
  type: string;
  created_at: number;
  session_id?: string | null;
  confidence?: number;
  valid_from?: number | null;
  properties?: string | null;
}

/** Row shape returned from edge queries (all columns). */
export interface EdgeRow {
  id: number;
  curator_id: string;
  source_id: string;
  target_id: string;
  type: string;
  valid_from: number | null;
  valid_until: number | null;
  session_id: string | null;
  confidence: number;
  properties: string | null;
  created_at: number;
}

/** Filter options for `listEdges`. */
export interface ListEdgesOptions {
  curator_id?: string;
  source_id?: string;
  target_id?: string;
  type?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

export const EDGE_COLUMNS = [
  'id',
  'curator_id',
  'source_id',
  'target_id',
  'type',
  'valid_from',
  'valid_until',
  'session_id',
  'confidence',
  'properties',
  'created_at',
] as const;

export const SELECT_EDGE_COLUMNS = EDGE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed EdgeRow. */
export function toEdgeRow(row: Record<string, unknown>): EdgeRow {
  return {
    id: row.id as number,
    curator_id: row.curator_id as string,
    source_id: row.source_id as string,
    target_id: row.target_id as string,
    type: row.type as string,
    valid_from: (row.valid_from as number) ?? null,
    valid_until: (row.valid_until as number) ?? null,
    session_id: (row.session_id as string) ?? null,
    confidence: row.confidence as number,
    properties: (row.properties as string) ?? null,
    created_at: row.created_at as number,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Insert a new directed edge between two entities.
 */
export async function insertEdge(data: EdgeInsert): Promise<EdgeRow> {
  const db = getDatabase();

  const result = await db.query(
    `INSERT INTO edges (
       curator_id, source_id, target_id, type,
       session_id, confidence, valid_from, properties, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT_EDGE_COLUMNS}`,
    [
      data.curator_id,
      data.source_id,
      data.target_id,
      data.type,
      data.session_id ?? null,
      data.confidence ?? DEFAULT_CONFIDENCE,
      data.valid_from ?? null,
      data.properties ?? null,
      data.created_at,
    ],
  );

  return toEdgeRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List edges with optional filters, ordered by created_at DESC.
 */
export async function listEdges(
  options: ListEdgesOptions = {},
): Promise<EdgeRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.curator_id !== undefined) {
    conditions.push(`curator_id = $${paramIndex++}`);
    params.push(options.curator_id);
  }

  if (options.source_id !== undefined) {
    conditions.push(`source_id = $${paramIndex++}`);
    params.push(options.source_id);
  }

  if (options.target_id !== undefined) {
    conditions.push(`target_id = $${paramIndex++}`);
    params.push(options.target_id);
  }

  if (options.type !== undefined) {
    conditions.push(`type = $${paramIndex++}`);
    params.push(options.type);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_EDGE_COLUMNS}
     FROM edges
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toEdgeRow);
}
