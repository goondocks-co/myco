import { listSpores, countSpores, getSpore } from '@myco/db/queries/spores.js';
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

/** Spore node name preview length (first N chars of content). */
const SPORE_NAME_PREVIEW_CHARS = 60;

/** Edge types to exclude from graph visualization (too granular). */
const EXCLUDED_GRAPH_EDGE_TYPES = new Set(['HAS_BATCH', 'EXTRACTED_FROM']);

// ---------------------------------------------------------------------------
// Spore handlers
// ---------------------------------------------------------------------------

export async function handleListSpores(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id; // undefined = all agents
  const type = req.query.type;
  const status = req.query.status;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const search = req.query.search || undefined;

  const filterOpts = {
    ...(agentId ? { agent_id: agentId } : {}),
    observation_type: type,
    status,
    search,
  };

  const spores = listSpores({ ...filterOpts, limit, offset });
  const total = countSpores(filterOpts);

  return { body: { spores, total, offset, limit } };
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

  // Filter out batch-related edges (too granular for visualization)
  const filteredEdges = graph.edges.filter(
    (e) => !EXCLUDED_GRAPH_EDGE_TYPES.has(e.type),
  );

  const graphDb = getDatabase();

  // Collect ALL unique node IDs from filtered edges, grouped by type
  const entityIds = new Set<string>();
  const sporeIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const edge of filteredEdges) {
    for (const [id, type] of [
      [edge.source_id, edge.source_type],
      [edge.target_id, edge.target_type],
    ] as [string, string][]) {
      switch (type) {
        case 'entity': entityIds.add(id); break;
        case 'spore': sporeIds.add(id); break;
        case 'session': sessionIds.add(id); break;
        // batch nodes are intentionally excluded
      }
    }
  }
  // Center entity is always included
  entityIds.add(center.id);

  // --- Batch-fetch entity nodes ---
  const entityIdArray = Array.from(entityIds);
  let entityNodes: Array<Record<string, unknown>> = [];
  if (entityIdArray.length > 0) {
    const placeholders = entityIdArray.map(() => '?').join(', ');
    entityNodes = graphDb.prepare(
      `SELECT id, type, name, properties, status, first_seen as created_at
       FROM entities WHERE id IN (${placeholders})`,
    ).all(...entityIdArray) as Array<Record<string, unknown>>;
  }

  // --- Batch-fetch spore nodes ---
  const sporeIdArray = Array.from(sporeIds);
  let sporeNodes: Array<Record<string, unknown>> = [];
  if (sporeIdArray.length > 0) {
    const placeholders = sporeIdArray.map(() => '?').join(', ');
    sporeNodes = graphDb.prepare(
      `SELECT id, observation_type, status, content, properties, created_at
       FROM spores WHERE id IN (${placeholders})`,
    ).all(...sporeIdArray) as Array<Record<string, unknown>>;
  }

  // --- Batch-fetch session nodes ---
  const sessionIdArray = Array.from(sessionIds);
  let sessionNodes: Array<Record<string, unknown>> = [];
  if (sessionIdArray.length > 0) {
    const placeholders = sessionIdArray.map(() => '?').join(', ');
    sessionNodes = graphDb.prepare(
      `SELECT id, title, summary, status, started_at as created_at
       FROM sessions WHERE id IN (${placeholders})`,
    ).all(...sessionIdArray) as Array<Record<string, unknown>>;
  }

  // --- Batch-fetch mention counts for entity nodes ---
  const mentionCounts = new Map<string, number>();
  if (entityIdArray.length > 0) {
    const placeholders = entityIdArray.map(() => '?').join(', ');
    const mentionRows = graphDb.prepare(
      `SELECT entity_id, COUNT(*) as count FROM entity_mentions
       WHERE entity_id IN (${placeholders}) GROUP BY entity_id`,
    ).all(...entityIdArray) as Array<Record<string, unknown>>;
    for (const row of mentionRows) {
      mentionCounts.set(row.entity_id as string, Number(row.count));
    }
  }

  // --- Build unified nodes array ---
  const allNodes = [
    ...entityNodes.map((n) => ({
      id: n.id as string,
      name: n.name as string,
      type: n.type as string,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      properties: (n.properties as string) ?? undefined,
      mention_count: mentionCounts.get(n.id as string) ?? 0,
    })),
    ...sporeNodes.map((n) => ({
      id: n.id as string,
      name: ((n.content as string) ?? '').slice(0, SPORE_NAME_PREVIEW_CHARS),
      type: 'spore' as const,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      content: n.content as string | undefined,
      properties: (n.properties as string) ?? undefined,
      observation_type: n.observation_type as string | undefined,
    })),
    ...sessionNodes.map((n) => ({
      id: n.id as string,
      name: (n.title as string) ?? `Session ${(n.id as string).slice(-6)}`,
      type: 'session' as const,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      content: (n.summary as string) ?? undefined,
    })),
  ];

  // Identify the center node from the unified array
  const centerNode = allNodes.find((n) => n.id === center.id);

  // Map edges to UI-friendly shape (label + weight instead of type + confidence)
  const uiEdges = filteredEdges.map((e) => ({
    source_id: e.source_id,
    target_id: e.target_id,
    label: e.type,
    weight: e.confidence,
  }));

  return {
    body: {
      center: centerNode ?? { ...center, mention_count: mentionCounts.get(center.id) ?? 0 },
      nodes: allNodes.filter((n) => n.id !== center.id),
      edges: uiEdges,
      depth,
    },
  };
}

// ---------------------------------------------------------------------------
// Full graph handler
// ---------------------------------------------------------------------------

/** Maximum nodes returned in full graph view to prevent overload. */
const FULL_GRAPH_NODE_LIMIT = 500;

export async function handleGetFullGraph(_req: RouteRequest): Promise<RouteResponse> {
  const db = getDatabase();

  // Fetch all entities
  const entityRows = db.prepare(
    `SELECT id, type, name, properties, status, first_seen as created_at
     FROM entities WHERE agent_id = ? LIMIT ?`,
  ).all(DEFAULT_AGENT_ID, FULL_GRAPH_NODE_LIMIT) as Array<Record<string, unknown>>;

  // Fetch active spores (skip superseded)
  const sporeRows = db.prepare(
    `SELECT id, observation_type, status, content, properties, created_at
     FROM spores WHERE agent_id = ? AND status = 'active' LIMIT ?`,
  ).all(DEFAULT_AGENT_ID, FULL_GRAPH_NODE_LIMIT) as Array<Record<string, unknown>>;

  // Fetch recent sessions
  const sessionRows = db.prepare(
    `SELECT id, title, summary, status, started_at as created_at
     FROM sessions ORDER BY created_at DESC LIMIT ?`,
  ).all(FULL_GRAPH_NODE_LIMIT) as Array<Record<string, unknown>>;

  // Collect all node IDs for edge filtering
  const allIds = new Set<string>();
  for (const r of [...entityRows, ...sporeRows, ...sessionRows]) {
    allIds.add(r.id as string);
  }

  // Fetch all edges between known nodes, excluding batch-level edges
  const excludedTypes = Array.from(EXCLUDED_GRAPH_EDGE_TYPES).map(() => '?').join(', ');
  const edgeRows = db.prepare(
    `SELECT source_id, source_type, target_id, target_type, type, confidence
     FROM graph_edges
     WHERE agent_id = ? AND type NOT IN (${excludedTypes})`,
  ).all(DEFAULT_AGENT_ID, ...Array.from(EXCLUDED_GRAPH_EDGE_TYPES)) as Array<Record<string, unknown>>;

  // Only keep edges where both endpoints are in our node set
  const filteredEdges = edgeRows.filter(
    (e) => allIds.has(e.source_id as string) && allIds.has(e.target_id as string),
  );

  // Mention counts for entity sizing
  const mentionCounts = new Map<string, number>();
  const entityIdArray = entityRows.map((r) => r.id as string);
  if (entityIdArray.length > 0) {
    const placeholders = entityIdArray.map(() => '?').join(', ');
    const mentionRows = db.prepare(
      `SELECT entity_id, COUNT(*) as count FROM entity_mentions
       WHERE entity_id IN (${placeholders}) GROUP BY entity_id`,
    ).all(...entityIdArray) as Array<Record<string, unknown>>;
    for (const row of mentionRows) {
      mentionCounts.set(row.entity_id as string, Number(row.count));
    }
  }

  // Build nodes
  const nodes = [
    ...entityRows.map((n) => ({
      id: n.id as string,
      name: n.name as string,
      type: n.type as string,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      properties: (n.properties as string) ?? undefined,
      mention_count: mentionCounts.get(n.id as string) ?? 0,
    })),
    ...sporeRows.map((n) => ({
      id: n.id as string,
      name: ((n.content as string) ?? '').slice(0, SPORE_NAME_PREVIEW_CHARS),
      type: 'spore' as const,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      content: n.content as string | undefined,
      properties: (n.properties as string) ?? undefined,
      observation_type: n.observation_type as string | undefined,
    })),
    ...sessionRows.map((n) => ({
      id: n.id as string,
      name: (n.title as string) ?? `Session ${(n.id as string).slice(-6)}`,
      type: 'session' as const,
      status: (n.status as string) ?? undefined,
      created_at: n.created_at as number | undefined,
      content: (n.summary as string) ?? undefined,
    })),
  ];

  const edges = filteredEdges.map((e) => ({
    source_id: e.source_id as string,
    target_id: e.target_id as string,
    label: e.type as string,
    weight: e.confidence as number | undefined,
  }));

  return { body: { nodes, edges } };
}

// ---------------------------------------------------------------------------
// Digest handler
// ---------------------------------------------------------------------------

export async function handleGetDigest(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id ?? DEFAULT_AGENT_ID;
  const extracts = listDigestExtracts(agentId);
  return { body: { tiers: extracts } };
}
