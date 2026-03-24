import { listSpores, getSpore } from '@myco/db/queries/spores.js';
import { listEntities, getEntityWithEdges } from '@myco/db/queries/entities.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default number of items returned by list endpoints. */
const DEFAULT_LIST_LIMIT = 50;

/** Default pagination offset for list endpoints. */
const DEFAULT_LIST_OFFSET = 0;

/** Default graph traversal depth. */
const DEFAULT_GRAPH_DEPTH = 1;

/** Maximum graph traversal depth (capped for performance). */
const MAX_GRAPH_DEPTH = 3;

// ---------------------------------------------------------------------------
// Spore handlers
// ---------------------------------------------------------------------------

export async function handleListSpores(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id ?? DEFAULT_AGENT_ID;
  const type = req.query.type;
  const status = req.query.status;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;

  const spores = await listSpores({
    agent_id: agentId,
    observation_type: type,
    status,
    limit,
    offset,
  });

  return { body: { spores, total: spores.length, offset, limit } };
}

export async function handleGetSpore(req: RouteRequest): Promise<RouteResponse> {
  const spore = await getSpore(req.params.id);
  if (!spore) return { status: 404, body: { error: 'not_found' } };
  return { body: spore };
}

// ---------------------------------------------------------------------------
// Entity handlers
// ---------------------------------------------------------------------------

export async function handleListEntities(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id ?? DEFAULT_AGENT_ID;
  const type = req.query.type;
  const mentioned_in = req.query.mentioned_in;
  const note_type = req.query.note_type;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;

  const entities = await listEntities({
    agent_id: agentId,
    type,
    mentioned_in,
    note_type,
    limit,
    offset,
  });

  return { body: { entities } };
}

// ---------------------------------------------------------------------------
// Graph handler
// ---------------------------------------------------------------------------

export async function handleGetGraph(req: RouteRequest): Promise<RouteResponse> {
  const depth = Math.min(Number(req.query.depth) || DEFAULT_GRAPH_DEPTH, MAX_GRAPH_DEPTH);

  const graph = await getEntityWithEdges(req.params.id, depth);
  if (!graph) return { status: 404, body: { error: 'not_found' } };

  const db = getDatabase();

  // Batch-fetch mention counts for all nodes (including center) in a single query
  const allNodeIds = [graph.center.id, ...graph.nodes.map((n) => n.id)];
  const mentionCounts = new Map<string, number>();

  if (allNodeIds.length > 0) {
    const placeholders = allNodeIds.map((_, i) => `$${i + 1}`).join(', ');
    const result = await db.query(
      `SELECT entity_id, COUNT(*) as count FROM entity_mentions
       WHERE entity_id IN (${placeholders}) GROUP BY entity_id`,
      allNodeIds,
    );
    for (const row of result.rows as Array<Record<string, unknown>>) {
      mentionCounts.set(row.entity_id as string, Number(row.count));
    }
  }

  const nodesWithMentions = graph.nodes.map((node) => ({
    ...node,
    mention_count: mentionCounts.get(node.id) ?? 0,
  }));

  return {
    body: {
      center: { ...graph.center, mention_count: mentionCounts.get(graph.center.id) ?? 0 },
      nodes: nodesWithMentions,
      edges: graph.edges,
      depth,
    },
  };
}

// ---------------------------------------------------------------------------
// Digest handler
// ---------------------------------------------------------------------------

export async function handleGetDigest(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id ?? DEFAULT_AGENT_ID;
  const extracts = await listDigestExtracts(agentId);
  return { body: { tiers: extracts } };
}
