import { listSpores, getSpore } from '@myco/db/queries/spores.js';
import { listEntities, getEntity } from '@myco/db/queries/entities.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getGraphForNode } from '@myco/db/queries/graph-edges.js';
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
  const agentId = req.query.agent_id; // undefined = all agents
  const type = req.query.type;
  const status = req.query.status;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;

  const spores = listSpores({
    ...(agentId ? { agent_id: agentId } : {}),
    observation_type: type,
    status,
    limit,
    offset,
  });

  return { body: { spores, total: spores.length, offset, limit } };
}

export async function handleGetSpore(req: RouteRequest): Promise<RouteResponse> {
  const spore = getSpore(req.params.id);
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

  const entities = listEntities({
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

  // Verify center entity exists
  const center = getEntity(req.params.id);
  if (!center) return { status: 404, body: { error: 'not_found' } };

  // Use graph_edges for BFS traversal
  const graph = getGraphForNode(req.params.id, 'entity', { depth });

  const graphDb = getDatabase();

  // Collect all unique entity IDs from edges for node fetching + mention counts
  const entityIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.source_type === 'entity') entityIds.add(edge.source_id);
    if (edge.target_type === 'entity') entityIds.add(edge.target_id);
  }
  entityIds.delete(center.id); // exclude center from "nodes" list

  // Batch-fetch connected entity nodes
  const nodeIdArray = Array.from(entityIds);
  let nodes: Array<Record<string, unknown>> = [];
  if (nodeIdArray.length > 0) {
    const placeholders = nodeIdArray.map(() => '?').join(', ');
    nodes = graphDb.prepare(
      `SELECT id, agent_id, type, name, properties, first_seen, last_seen, status
       FROM entities WHERE id IN (${placeholders})`,
    ).all(...nodeIdArray) as Array<Record<string, unknown>>;
  }

  // Batch-fetch mention counts for all entity nodes (including center)
  const allEntityIds = [center.id, ...nodeIdArray];
  const mentionCounts = new Map<string, number>();
  if (allEntityIds.length > 0) {
    const placeholders = allEntityIds.map(() => '?').join(', ');
    const mentionRows = graphDb.prepare(
      `SELECT entity_id, COUNT(*) as count FROM entity_mentions
       WHERE entity_id IN (${placeholders}) GROUP BY entity_id`,
    ).all(...allEntityIds) as Array<Record<string, unknown>>;
    for (const row of mentionRows) {
      mentionCounts.set(row.entity_id as string, Number(row.count));
    }
  }

  const nodesWithMentions = nodes.map((node) => ({
    ...node,
    mention_count: mentionCounts.get(node.id as string) ?? 0,
  }));

  return {
    body: {
      center: { ...center, mention_count: mentionCounts.get(center.id) ?? 0 },
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
  const extracts = listDigestExtracts(agentId);
  return { body: { tiers: extracts } };
}
