import type { RelationalStore } from '../core/adapters.js';
import { telemetryLineageEdges, telemetryLineageSessions } from '../db/sessions/telemetry-lineage.js';
import type { lineage_SessionLineage } from './catalog/lineage.js';
import { sessions_sessionLabel } from './catalog/sessions.js';

type Node = lineage_SessionLineage['nodes'][number];
type Edge = lineage_SessionLineage['edges'][number];
const key = (project: string, session: string) => JSON.stringify([project, session]);

/** Extends the stored family with explicit telemetry edges, keeping both endpoint Projects on cross-Project links. */
export async function extendTelemetryLineage(db: RelationalStore, projectId: string, base: lineage_SessionLineage): Promise<lineage_SessionLineage> {
  const nodes = new Map(base.nodes.map(node => [key(node.projectId ?? projectId, node.sessionId), node]));
  const edges: Edge[] = [...base.edges];
  let frontier = base.nodes.filter(node => node.captured).map(node => ({ projectId: node.projectId ?? projectId, sessionId: node.sessionId }));
  const visited = new Set<string>();
  let truncated = base.truncated;
  for (let depth = 0; frontier.length > 0 && depth < 8; depth++) {
    for (const pair of frontier) visited.add(key(pair.projectId, pair.sessionId));
    const reported = await telemetryLineageEdges(db, frontier, 201);
    if (reported.length > 200) truncated = true;
    const pairs = new Map<string, { projectId: string; sessionId: string }>();
    for (const edge of reported.slice(0, 200)) {
      for (const pair of [{ projectId: edge.parentProjectId, sessionId: edge.parentId }, { projectId: edge.childProjectId, sessionId: edge.childId }]) {
        if (!nodes.has(key(pair.projectId, pair.sessionId))) pairs.set(key(pair.projectId, pair.sessionId), pair);
      }
    }
    const room = 200 - nodes.size;
    if (pairs.size > room) truncated = true;
    const found = await telemetryLineageSessions(db, [...pairs.values()].slice(0, Math.max(0, room)));
    for (const row of found) nodes.set(key(row.projectId, row.sessionId), {
      sessionId: row.sessionId, ...(row.projectId === projectId ? {} : { projectId: row.projectId }), captured: true,
      label: sessions_sessionLabel(row.label, row.firstPrompt, row.agent), agent: row.agent, startedAt: row.startedAt, endedAt: row.endedAt,
      depth: 0, placedUnder: null, current: false,
    });
    frontier = [];
    for (const edge of reported.slice(0, 200)) {
      const parent = key(edge.parentProjectId, edge.parentId), child = key(edge.childProjectId, edge.childId);
      if (!nodes.has(parent) || !nodes.has(child)) continue;
      if (!edges.some(held => key(held.parentProjectId ?? projectId, held.parentId) === parent && key(held.childProjectId ?? projectId, held.childId) === child && held.kind === 'launched')) {
        edges.push({ parentId: edge.parentId, childId: edge.childId, kind: 'launched', reason: null, source: 'telemetry', serviceName: edge.serviceName,
          inferred: edge.inferred === 1, ...(edge.parentProjectId === projectId ? {} : { parentProjectId: edge.parentProjectId }),
          ...(edge.childProjectId === projectId ? {} : { childProjectId: edge.childProjectId }) });
      }
      for (const [id, pair] of [[parent, { projectId: edge.parentProjectId, sessionId: edge.parentId }], [child, { projectId: edge.childProjectId, sessionId: edge.childId }]] as const) {
        if (!visited.has(id)) { frontier.push(pair); visited.add(id); }
      }
    }
    if (depth === 7 && frontier.length > 0) truncated = true;
  }
  if (edges.length === base.edges.length) return base;
  const childKey = (edge: Edge) => key(edge.childProjectId ?? projectId, edge.childId);
  const parentKey = (edge: Edge) => key(edge.parentProjectId ?? projectId, edge.parentId);
  const sort = (a: Node, b: Node) => (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || a.sessionId.localeCompare(b.sessionId);
  const roots = [...nodes.entries()].filter(([id]) => !edges.some(edge => childKey(edge) === id && nodes.has(parentKey(edge)))).map(([, node]) => node).sort(sort);
  const output: Node[] = [], placed = new Set<string>();
  const place = (node: Node, depth: number, under: Edge | null) => {
    const id = key(node.projectId ?? projectId, node.sessionId);
    if (placed.has(id)) return;
    placed.add(id);
    output.push({ ...node, depth, placedUnder: under });
    const children = edges.filter(edge => parentKey(edge) === id).map(edge => ({ edge, node: nodes.get(childKey(edge)) })).filter(item => item.node !== undefined);
    children.sort((a, b) => sort(a.node!, b.node!));
    for (const child of children) place(child.node!, depth + 1, child.edge);
  };
  for (const node of roots) place(node, 0, null);
  for (const node of nodes.values()) place(node, 0, null);
  return { nodes: output, edges, truncated };
}
