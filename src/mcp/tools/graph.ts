/**
 * myco_graph — traverse connections between vault notes via entities and edges.
 *
 * Phase 1: the entities/edges tables are empty (populated by future
 * intelligence agents). Returns empty results gracefully. The handler
 * structure is in place for Phase 3 knowledge graph features.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum traversal depth to prevent runaway queries. */
const MAX_DEPTH = 3;

/** Default traversal depth. */
const DEFAULT_DEPTH = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphInput {
  note_id: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
}

interface GraphEdge {
  source_id: string;
  target_id: string;
  type: string;
  confidence: number;
}

interface GraphResult {
  note_id: string;
  edges: GraphEdge[];
  entities: Array<{ id: string; type: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoGraph(
  input: GraphInput,
): Promise<GraphResult> {
  const db = getDatabase();
  const direction = input.direction ?? 'both';
  const depth = Math.min(input.depth ?? DEFAULT_DEPTH, MAX_DEPTH);

  // Query entity_mentions for this note to find related entities
  const mentions = await db.query(
    `SELECT DISTINCT entity_id
     FROM entity_mentions
     WHERE note_id = $1`,
    [input.note_id],
  );

  const entityIds = (mentions.rows as Record<string, unknown>[]).map(
    (r) => r.entity_id as string,
  );

  if (entityIds.length === 0) {
    return { note_id: input.note_id, edges: [], entities: [] };
  }

  // Fetch the entities
  const placeholders = entityIds.map((_, i) => `$${i + 1}`).join(', ');
  const entities = await db.query(
    `SELECT id, type, name
     FROM entities
     WHERE id IN (${placeholders})`,
    entityIds,
  );

  // Fetch edges connected to these entities
  const edgeConditions: string[] = [];
  if (direction === 'outgoing' || direction === 'both') {
    edgeConditions.push(`source_id IN (${placeholders})`);
  }
  if (direction === 'incoming' || direction === 'both') {
    edgeConditions.push(`target_id IN (${placeholders})`);
  }

  const edgeWhere = edgeConditions.join(' OR ');
  const edges = await db.query(
    `SELECT source_id, target_id, type, confidence
     FROM edges
     WHERE ${edgeWhere}`,
    entityIds,
  );

  return {
    note_id: input.note_id,
    edges: (edges.rows as Record<string, unknown>[]).map((r) => ({
      source_id: r.source_id as string,
      target_id: r.target_id as string,
      type: r.type as string,
      confidence: (r.confidence as number) ?? 1.0,
    })),
    entities: (entities.rows as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      type: r.type as string,
      name: r.name as string,
    })),
  };
}
