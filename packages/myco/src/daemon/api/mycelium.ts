import { listSpores, countSpores, getSpore } from '@myco/db/queries/spores.js';
import { listEntities } from '@myco/db/queries/entities.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getGraphForNode } from '@myco/db/queries/graph-edges.js';
import { getDatabase } from '@myco/db/client.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { projectScopeFromRequestContext, rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';
import {
  releaseStateAnnotation,
  releaseStateAnnotationMap,
  releaseStateField,
} from '@myco/release-provenance/annotations.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import { fetchTeamFallback, type TeamFallbackDeps } from './team-fallback.js';

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

/** Seed counts for focused graph startup. */
const GRAPH_SEED_SPORE_LIMIT = 4;
const GRAPH_SEED_SESSION_LIMIT = 4;

/** Edge types to exclude from graph visualization (too granular). */
const EXCLUDED_GRAPH_EDGE_TYPES = new Set(['HAS_BATCH', 'EXTRACTED_FROM']);

function projectScopeClause(projectId: string | null | undefined): { sql: string; params: unknown[] } {
  if (projectId === undefined) return { sql: '', params: [] };
  if (projectId === null) return { sql: ' AND project_id IS NULL', params: [] };
  return { sql: ' AND project_id = ?', params: [projectId] };
}

// ---------------------------------------------------------------------------
// Spore handlers
// ---------------------------------------------------------------------------

export async function handleListSpores(req: RouteRequest): Promise<RouteResponse> {
  const agentId = req.query.agent_id; // undefined = all agents
  const type = req.query.type;
  const status = req.query.status;
  const session_id = req.query.session_id || undefined;
  const limit = req.query.limit ? Number(req.query.limit) : DEFAULT_LIST_LIMIT;
  const offset = req.query.offset ? Number(req.query.offset) : DEFAULT_LIST_OFFSET;
  const search = req.query.search || undefined;
  const projectId = rowProjectIdFromRequestContext(req.requestContext);

  const scope = projectScopeFromRequestContext(req.requestContext);
  const filterOpts = {
    scope,
    ...(agentId ? { agent_id: agentId } : {}),
    observation_type: type,
    status,
    session_id,
    search,
  };

  const rawSpores = listSpores({ ...filterOpts, limit, offset });
  const total = countSpores(filterOpts);
  const states = releaseStateAnnotationMap('spores', rawSpores.map((s) => s.id), scope);
  const spores = rawSpores.map((s) => ({ ...s, ...releaseStateField(states.get(s.id)) }));

  return { body: { spores, total, offset, limit } };
}

/** Factory form — supports team fallback when the spore is missing locally. */
export function createGetSporeHandler(deps: TeamFallbackDeps = {}) {
  return async function handleGetSpore(req: RouteRequest): Promise<RouteResponse> {
    const scope = projectScopeFromRequestContext(req.requestContext);
    const spore = getSpore(req.params.id, scope);
    if (spore) {
      return {
        body: {
          ...spore,
          ...releaseStateField(releaseStateAnnotation('spores', spore.id, scope)),
          source: 'local',
        },
      };
    }

    const fallback = await fetchTeamFallback(deps, 'spores', req.params.id);
    if (fallback) {
      return { body: { ...fallback.record, source: fallback.source } };
    }

    return { status: 404, body: { error: 'not_found' } };
  };
}

/** Back-compat: no-team-fallback handler for existing call sites. */
export const handleGetSpore = createGetSporeHandler();

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

  const scope = projectScopeFromRequestContext(req.requestContext);
  const entities = listEntities({
    scope,
    agent_id: agentId,
    type,
    mentioned_in,
    note_type,
    limit,
    offset,
  });

  return { body: { entities } };
}

export async function handleGetGraphSeeds(req: RouteRequest): Promise<RouteResponse> {
  const db = getDatabase();
  const projectId = rowProjectIdFromRequestContext(req.requestContext);
  const projectScope = projectScopeClause(projectId);

  const sporeRows = db.prepare(
    `SELECT id, observation_type, status, content, created_at
     FROM spores
     WHERE agent_id = ? AND status = 'active'${projectScope.sql}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(DEFAULT_AGENT_ID, ...projectScope.params, GRAPH_SEED_SPORE_LIMIT) as Array<Record<string, unknown>>;

  const sessionRows = db.prepare(
    `SELECT id, title, summary, status, started_at as created_at
     FROM sessions
     WHERE status != 'active'${projectScope.sql}
     ORDER BY started_at DESC
     LIMIT ?`,
  ).all(...projectScope.params, GRAPH_SEED_SESSION_LIMIT) as Array<Record<string, unknown>>;

  const sporeSeeds = sporeRows.map((row) => ({
      id: row.id as string,
      name: ((row.content as string) ?? '').slice(0, SPORE_NAME_PREVIEW_CHARS),
      type: 'spore' as const,
      status: (row.status as string) ?? undefined,
      created_at: row.created_at as number | undefined,
      content: row.content as string | undefined,
      observation_type: row.observation_type as string | undefined,
    }));
  const sessionSeeds = sessionRows.map((row) => ({
      id: row.id as string,
      name: (row.title as string) ?? `Session ${(row.id as string).slice(-6)}`,
      type: 'session' as const,
      status: (row.status as string) ?? undefined,
      created_at: row.created_at as number | undefined,
      content: (row.summary as string) ?? undefined,
    }));

  // Recommend the most-connected node in the visible lineage graph so the
  // default focus lands on a rich neighborhood instead of a freshly-completed
  // session that has not had spores extracted yet. Batch edges are excluded
  // from the count to match what the visualization actually renders.
  const topConnectedRow = db.prepare(
    `SELECT node_id FROM (
       SELECT source_id AS node_id, COUNT(*) AS cnt
         FROM graph_edges
        WHERE agent_id = ?
          ${projectScope.sql}
          AND type NOT IN ('HAS_BATCH', 'EXTRACTED_FROM')
          AND source_type IN ('spore', 'session')
        GROUP BY source_id
       UNION ALL
       SELECT target_id, COUNT(*)
         FROM graph_edges
        WHERE agent_id = ?
          ${projectScope.sql}
          AND type NOT IN ('HAS_BATCH', 'EXTRACTED_FROM')
          AND target_type IN ('spore', 'session')
        GROUP BY target_id
     )
     GROUP BY node_id
     ORDER BY SUM(cnt) DESC
      LIMIT 1`,
  ).get(DEFAULT_AGENT_ID, ...projectScope.params, DEFAULT_AGENT_ID, ...projectScope.params) as { node_id: string } | undefined;

  // Materialize the top-connected node as a seed so the UI's
  // `seeds.find(s => s.id === recommended_id)` lookup succeeds.
  let topSeed: Record<string, unknown> | null = null;
  if (topConnectedRow?.node_id) {
    const topId = topConnectedRow.node_id;
    const sporeHit = db.prepare(
      `SELECT id, observation_type, status, content, created_at
         FROM spores WHERE id = ?${projectScope.sql}`,
    ).get(topId, ...projectScope.params) as Record<string, unknown> | undefined;
    if (sporeHit) {
      topSeed = {
        id: sporeHit.id as string,
        name: ((sporeHit.content as string) ?? '').slice(0, SPORE_NAME_PREVIEW_CHARS),
        type: 'spore' as const,
        status: (sporeHit.status as string) ?? undefined,
        created_at: sporeHit.created_at as number | undefined,
        content: sporeHit.content as string | undefined,
        observation_type: sporeHit.observation_type as string | undefined,
      };
    } else {
      const sessionHit = db.prepare(
        `SELECT id, title, summary, status, started_at as created_at
           FROM sessions WHERE id = ?${projectScope.sql}`,
      ).get(topId, ...projectScope.params) as Record<string, unknown> | undefined;
      if (sessionHit) {
        topSeed = {
          id: sessionHit.id as string,
          name: (sessionHit.title as string) ?? `Session ${(sessionHit.id as string).slice(-6)}`,
          type: 'session' as const,
          status: (sessionHit.status as string) ?? undefined,
          created_at: sessionHit.created_at as number | undefined,
          content: (sessionHit.summary as string) ?? undefined,
        };
      }
    }
  }

  const seeds = [
    ...(topSeed ? [topSeed] : []),
    ...sessionSeeds.filter((s) => s.id !== topSeed?.id),
    ...sporeSeeds.filter((s) => s.id !== topSeed?.id),
  ];

  const recommendedId = topSeed?.id as string | undefined
    ?? sessionSeeds[0]?.id
    ?? sporeSeeds[0]?.id
    ?? null;

  return {
    body: {
      seeds,
      recommended_id: recommendedId,
    },
  };
}

// ---------------------------------------------------------------------------
// Graph handler
// ---------------------------------------------------------------------------

export async function handleGetGraph(req: RouteRequest): Promise<RouteResponse> {
  const depth = Math.min(Number(req.query.depth) || DEFAULT_GRAPH_DEPTH, MAX_GRAPH_DEPTH);
  const id = req.params.id;
  const projectId = rowProjectIdFromRequestContext(req.requestContext);
  const projectScope = projectScopeClause(projectId);

  // Resolve center node — spore or session (entity layer retired in schema v21).
  const scope = projectScopeFromRequestContext(req.requestContext);
  let centerType: 'spore' | 'session';
  if (getSpore(id, scope)) {
    centerType = 'spore';
  } else if (getSession(id, scope)) {
    centerType = 'session';
  } else {
    return { status: 404, body: { error: 'not_found' } };
  }

  const graph = getGraphForNode(id, centerType, { depth, scope });

  // Filter out batch-related edges (too granular for visualization)
  const filteredEdges = graph.edges.filter(
    (e) => !EXCLUDED_GRAPH_EDGE_TYPES.has(e.type),
  );

  const graphDb = getDatabase();

  const sporeIds = new Set<string>();
  const sessionIds = new Set<string>();

  for (const edge of filteredEdges) {
    for (const [nodeId, type] of [
      [edge.source_id, edge.source_type],
      [edge.target_id, edge.target_type],
    ] as [string, string][]) {
      if (type === 'spore') sporeIds.add(nodeId);
      else if (type === 'session') sessionIds.add(nodeId);
      // batch nodes intentionally excluded
    }
  }

  if (centerType === 'spore') sporeIds.add(id);
  else sessionIds.add(id);

  const sporeIdArray = Array.from(sporeIds);
  const sporeNodes = sporeIdArray.length > 0
    ? (graphDb.prepare(
        `SELECT id, observation_type, status, content, properties, created_at
         FROM spores WHERE id IN (${sporeIdArray.map(() => '?').join(', ')})${projectScope.sql}`,
      ).all(...sporeIdArray, ...projectScope.params) as Array<Record<string, unknown>>)
    : [];

  const sessionIdArray = Array.from(sessionIds);
  const sessionNodes = sessionIdArray.length > 0
    ? (graphDb.prepare(
        `SELECT id, title, summary, status, started_at as created_at
         FROM sessions WHERE id IN (${sessionIdArray.map(() => '?').join(', ')})${projectScope.sql}`,
      ).all(...sessionIdArray, ...projectScope.params) as Array<Record<string, unknown>>)
    : [];

  const allNodes = [
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

  // Map edges to UI-friendly shape (label + weight instead of type + confidence)
  const uiEdges = filteredEdges.map((e) => ({
    source_id: e.source_id,
    target_id: e.target_id,
    label: e.type,
    weight: e.confidence,
  }));

  const centerResponseNode = allNodes.find((n) => n.id === id);

  return {
    body: {
      center: centerResponseNode,
      nodes: allNodes.filter((n) => n.id !== id),
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

export async function handleGetFullGraph(req: RouteRequest): Promise<RouteResponse> {
  const db = getDatabase();
  const projectId = rowProjectIdFromRequestContext(req.requestContext);
  const projectScope = projectScopeClause(projectId);

  // Fetch active spores (skip superseded)
  const sporeRows = db.prepare(
    `SELECT id, observation_type, status, content, properties, created_at
     FROM spores WHERE agent_id = ? AND status = 'active'${projectScope.sql} LIMIT ?`,
  ).all(DEFAULT_AGENT_ID, ...projectScope.params, FULL_GRAPH_NODE_LIMIT) as Array<Record<string, unknown>>;

  // Fetch recent sessions
  const sessionRows = db.prepare(
    `SELECT id, title, summary, status, started_at as created_at
     FROM sessions WHERE 1=1${projectScope.sql} ORDER BY created_at DESC LIMIT ?`,
  ).all(...projectScope.params, FULL_GRAPH_NODE_LIMIT) as Array<Record<string, unknown>>;

  // Fetch plans across ALL statuses via the shared query helper. A plan you
  // advance or pick up is in_progress/completed — exactly the cross-session
  // lineage case — so an active-only filter would hide the very plans whose
  // touch edges we want to render. Plans are session-born artifacts; their
  // plan↔session edges only render once both endpoints exist as nodes.
  const planRows = listPlans({
    scope: projectScopeFromRequestContext(req.requestContext),
    limit: FULL_GRAPH_NODE_LIMIT,
  });

  // Collect all node IDs for edge filtering
  const allIds = new Set<string>();
  for (const r of [...sporeRows, ...sessionRows, ...planRows]) {
    allIds.add(r.id as string);
  }

  // Fetch edges between known nodes, excluding batch-level edges
  const excludedTypes = Array.from(EXCLUDED_GRAPH_EDGE_TYPES).map(() => '?').join(', ');
  const allIdsList = Array.from(allIds);
  const idPlaceholders = allIdsList.map(() => '?').join(', ');
  const edgeRows = allIdsList.length > 0
    ? (db.prepare(
        `SELECT source_id, source_type, target_id, target_type, type, confidence
         FROM graph_edges
         WHERE agent_id = ?
           ${projectScope.sql}
           AND type NOT IN (${excludedTypes})
           AND source_id IN (${idPlaceholders})
           AND target_id IN (${idPlaceholders})`,
      ).all(DEFAULT_AGENT_ID, ...projectScope.params, ...Array.from(EXCLUDED_GRAPH_EDGE_TYPES), ...allIdsList, ...allIdsList) as Array<Record<string, unknown>>)
    : [];

  // Build nodes
  const nodes = [
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
    ...planRows.map((n) => ({
      id: n.id,
      name: n.title ?? `Plan ${n.id.slice(-6)}`,
      type: 'plan' as const,
      status: n.status,
      created_at: n.created_at,
      content: n.content ?? undefined,
    })),
  ];

  const edges = edgeRows.map((e) => ({
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
  const scope = projectScopeFromRequestContext(req.requestContext);
  const extracts = listDigestExtracts(agentId, scope);
  return { body: { tiers: extracts } };
}
