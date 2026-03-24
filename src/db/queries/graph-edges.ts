/**
 * Graph edge CRUD query helpers.
 *
 * Unlike the `edges` table (which has FK constraints to entities), `graph_edges`
 * supports edges between any node types (session, batch, spore, entity).
 *
 * All functions obtain the PGlite instance internally via `getDatabase()`.
 */

import crypto from 'node:crypto';
import { getDatabase } from '@myco/db/client.js';
import { QUERY_DEFAULT_LIST_LIMIT, GRAPH_EDGE_DEFAULT_CONFIDENCE } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default BFS traversal depth. */
const DEFAULT_BFS_DEPTH = 2;

/** Maximum BFS traversal depth (capped for performance). */
const MAX_BFS_DEPTH = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Valid node types in the graph. */
export type GraphNodeType = 'session' | 'batch' | 'spore' | 'entity';

/** Lineage edge types (auto-created by daemon, no LLM). */
export type LineageEdgeType = 'FROM_SESSION' | 'EXTRACTED_FROM' | 'DERIVED_FROM' | 'HAS_BATCH';

/** Semantic edge types (created by intelligence agent, LLM-driven). */
export type SemanticEdgeType = 'RELATES_TO' | 'SUPERSEDED_BY' | 'REFERENCES' | 'DEPENDS_ON' | 'AFFECTS';

/** All valid graph edge types. */
export type GraphEdgeType = LineageEdgeType | SemanticEdgeType;

/** Fields required (or optional) when inserting a graph edge. */
export interface GraphEdgeInsert {
  agent_id: string;
  source_id: string;
  source_type: GraphNodeType;
  target_id: string;
  target_type: GraphNodeType;
  type: GraphEdgeType;
  created_at: number;
  session_id?: string;
  confidence?: number;
  properties?: string;
}

/** Row shape returned from graph edge queries. */
export interface GraphEdgeRow {
  id: string;
  agent_id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  type: string;
  session_id: string | null;
  confidence: number;
  properties: string | null;
  created_at: number;
}

/** Filter options for `listGraphEdges`. */
export interface ListGraphEdgesOptions {
  sourceId?: string;
  targetId?: string;
  type?: string;
  agentId?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Column list
// ---------------------------------------------------------------------------

const GRAPH_EDGE_COLUMNS = [
  'id',
  'agent_id',
  'source_id',
  'source_type',
  'target_id',
  'target_type',
  'type',
  'session_id',
  'confidence',
  'properties',
  'created_at',
] as const;

const SELECT_COLUMNS = GRAPH_EDGE_COLUMNS.join(', ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a PGlite result row into a typed GraphEdgeRow. */
function toGraphEdgeRow(row: Record<string, unknown>): GraphEdgeRow {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    source_id: row.source_id as string,
    source_type: row.source_type as string,
    target_id: row.target_id as string,
    target_type: row.target_type as string,
    type: row.type as string,
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
 * Insert a new graph edge.
 *
 * Generates a UUID id automatically.
 */
export async function insertGraphEdge(data: GraphEdgeInsert): Promise<GraphEdgeRow> {
  const db = getDatabase();
  const id = crypto.randomUUID();

  const result = await db.query(
    `INSERT INTO graph_edges (
       id, agent_id, source_id, source_type, target_id, target_type,
       type, session_id, confidence, properties, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${SELECT_COLUMNS}`,
    [
      id,
      data.agent_id,
      data.source_id,
      data.source_type,
      data.target_id,
      data.target_type,
      data.type,
      data.session_id ?? null,
      data.confidence ?? GRAPH_EDGE_DEFAULT_CONFIDENCE,
      data.properties ?? null,
      data.created_at,
    ],
  );

  return toGraphEdgeRow(result.rows[0] as Record<string, unknown>);
}

/**
 * List graph edges with optional filters, ordered by created_at DESC.
 */
export async function listGraphEdges(
  options: ListGraphEdgesOptions = {},
): Promise<GraphEdgeRow[]> {
  const db = getDatabase();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (options.sourceId !== undefined) {
    conditions.push(`source_id = $${paramIndex++}`);
    params.push(options.sourceId);
  }

  if (options.targetId !== undefined) {
    conditions.push(`target_id = $${paramIndex++}`);
    params.push(options.targetId);
  }

  if (options.type !== undefined) {
    conditions.push(`type = $${paramIndex++}`);
    params.push(options.type);
  }

  if (options.agentId !== undefined) {
    conditions.push(`agent_id = $${paramIndex++}`);
    params.push(options.agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options.limit ?? QUERY_DEFAULT_LIST_LIMIT;

  params.push(limit);

  const result = await db.query(
    `SELECT ${SELECT_COLUMNS}
     FROM graph_edges
     ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );

  return (result.rows as Record<string, unknown>[]).map(toGraphEdgeRow);
}

/**
 * BFS traversal from a node across graph edges.
 *
 * Returns all edges reachable within `depth` hops from the starting node.
 *
 * @param nodeId   - The starting node ID.
 * @param nodeType - The starting node type.
 * @param options  - Optional depth limit (default 2, max 5).
 */
export async function getGraphForNode(
  nodeId: string,
  nodeType: GraphNodeType,
  options?: { depth?: number },
): Promise<{ edges: GraphEdgeRow[] }> {
  const db = getDatabase();
  const depth = Math.min(Math.max(options?.depth ?? DEFAULT_BFS_DEPTH, 1), MAX_BFS_DEPTH);

  const seenEdgeIds = new Set<string>();
  const collectedEdges: GraphEdgeRow[] = [];
  const visited = new Set<string>([`${nodeType}:${nodeId}`]);
  let frontier = new Set<string>([nodeId]);

  for (let hop = 0; hop < depth; hop++) {
    if (frontier.size === 0) break;

    const frontierArray = Array.from(frontier);
    const placeholders = frontierArray.map((_, i) => `$${i + 1}`).join(', ');

    const result = await db.query(
      `SELECT ${SELECT_COLUMNS}
       FROM graph_edges
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
      frontierArray,
    );

    const nextFrontier = new Set<string>();

    for (const row of result.rows as Record<string, unknown>[]) {
      const edge = toGraphEdgeRow(row);
      if (!seenEdgeIds.has(edge.id)) {
        seenEdgeIds.add(edge.id);
        collectedEdges.push(edge);
      }
      const sourceKey = `${edge.source_type}:${edge.source_id}`;
      const targetKey = `${edge.target_type}:${edge.target_id}`;
      if (!visited.has(sourceKey)) {
        visited.add(sourceKey);
        nextFrontier.add(edge.source_id);
      }
      if (!visited.has(targetKey)) {
        visited.add(targetKey);
        nextFrontier.add(edge.target_id);
      }
    }

    frontier = nextFrontier;
  }

  return { edges: collectedEdges };
}
