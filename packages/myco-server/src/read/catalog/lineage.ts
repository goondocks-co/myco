import type { RelationalStore as lineage_import_RelationalStore } from "../../core/adapters.js";
import { lineageChildIds, lineageSessionRows, type LineageSessionRow } from "../../db/sessions/lineage.js";
import { inListChunks as lineage_import_inListChunks } from "../scope.js";
import type { ReadScope as lineage_import_ReadScope } from "../scope.js";
import { sessions_relatedSessionLabel } from './sessions.js';

/** The most generations the walk climbs above the session, and descends below the root it reached. */
const lineage_LINEAGE_MAX_DEPTH = 8;

/** The most sessions one lineage holds, the session itself and its ancestors included. */
const lineage_LINEAGE_MAX_NODES = 200;

/** `launched`: the parent started the child (`launch_parent_session_id`). `continuation`: the child continues the parent's conversation under a new id (`parent_session_id`). */
const lineage_LINEAGE_EDGE_KINDS = ['launched', 'continuation'] as const;

type lineage_LineageEdgeKind = (typeof lineage_LINEAGE_EDGE_KINDS)[number];

interface lineage_LineageEdge {
  parentId: string;
  childId: string;
  kind: lineage_LineageEdgeKind;
  /** The continuation's recorded reason; null for a launch. */
  reason: string | null;
}

interface lineage_LineageNode {
  sessionId: string;
  /** False for a parent this Project holds no session for: it is named by a child's record alone. */
  captured: boolean;
  label: string | null;
  agent: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Generations below the root it is placed under. */
  depth: number;
  /** The edge it is placed under; null for a root. A session with two parents in the lineage is placed under the one nearer a root and keeps both edges. */
  placedUnder: lineage_LineageEdge | null;
  current: boolean;
}

interface lineage_SessionLineage {
  /** Every session of the lineage in tree order: each root, then what is placed under it, children by start. */
  nodes: lineage_LineageNode[];
  /** Every edge between two sessions of the lineage, both kinds. */
  edges: lineage_LineageEdge[];
  /** True when a bound stopped the walk with sessions left unread. */
  truncated: boolean;
}

type lineage_Row = LineageSessionRow;

/** The column that names each edge kind's parent. */
const lineage_PARENT_COLUMN: Record<lineage_LineageEdgeKind, 'launch_parent_session_id' | 'parent_session_id'> = {
  launched: 'launch_parent_session_id',
  continuation: 'parent_session_id',
};

/** A row's parents as edges, launch first. */
function lineage_parentEdges(row: lineage_Row): lineage_LineageEdge[] {
  return lineage_LINEAGE_EDGE_KINDS.flatMap((kind) => {
    const parentId = row[lineage_PARENT_COLUMN[kind]];
    return parentId === null || parentId === row.session_id ? [] : [{ parentId, childId: row.session_id, kind, reason: kind === 'continuation' ? row.parent_reason : null }];
  });
}

const lineage_byStart = (a: { startedAt: number | null; sessionId: string }, b: { startedAt: number | null; sessionId: string }): number =>
  (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

/** The live sessions this Project holds among `ids`. */
async function lineage_sessionsNamed(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, ids: readonly string[]): Promise<lineage_Row[]> {
  const out: lineage_Row[] = [];
  for (const run of lineage_import_inListChunks(ids)) out.push(...await lineageSessionRows(db, scope.projectId, run));
  return out;
}

/**
 * The ids of at most `limit` live sessions of this Project whose `kind` parent is one of `ids`, in the index's own order
 * (parent, then child id), so the read stops at the limit whatever the family's size.
 */
async function lineage_childIdsOf(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, kind: lineage_LineageEdgeKind, ids: readonly string[], limit: number): Promise<string[]> {
  const out: string[] = [];
  for (const run of lineage_import_inListChunks([...ids].sort())) {
    if (out.length >= limit) break;
    out.push(...await lineageChildIds(db, { project: scope.projectId, kind, parents: run, limit: limit - out.length }));
  }
  return out;
}

/**
 * The family of a session over both parent columns: up to its roots, then down from them, each step reading this
 * Project's live sessions alone. A parent named by a record but not held here is a node that is not captured, and the
 * walk goes no higher through it. Bounded at `LINEAGE_MAX_DEPTH` generations each way and `LINEAGE_MAX_NODES`
 * sessions; a session met again is not walked again, so a cycle in the records ends the walk. Null when the Project
 * does not hold the session.
 */
const lineage_sessionLineage = lineage_sessionLineageImpl;

async function lineage_sessionLineageImpl(db: lineage_import_RelationalStore, scope: lineage_import_ReadScope, sessionId: string): Promise<lineage_SessionLineage | null> {
  const [self] = await lineage_sessionsNamed(db, scope, [sessionId]);
  if (self === undefined) return null;
  const rows = new Map<string, lineage_Row>([[sessionId, self]]);
  const uncaptured = new Set<string>();
  const size = () => rows.size + uncaptured.size;
  let truncated = false;

  // Up: the parents of each generation, until none is named or held.
  let frontier = [self];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const named = [...new Set(frontier.flatMap(lineage_parentEdges).map((edge) => edge.parentId))]
      .filter((id) => !rows.has(id) && !uncaptured.has(id));
    if (named.length === 0) break;
    if (depth === lineage_LINEAGE_MAX_DEPTH || size() + named.length > lineage_LINEAGE_MAX_NODES) { truncated = true; break; }
    const found = await lineage_sessionsNamed(db, scope, named);
    for (const row of found) rows.set(row.session_id, row);
    for (const id of named) if (!rows.has(id)) uncaptured.add(id);
    frontier = found;
  }

  // Down: the children of each generation, from the sessions no edge in the lineage leads to. A session held from the
  // walk up is walked down too, once. Each generation selects child ids within the bound, then reads only the kept ones.
  const roots = lineage_rootsOf(rows, uncaptured, sessionId);
  const expanded = new Set<string>();
  let parents = roots;
  for (let depth = 0; parents.length > 0; depth += 1) {
    for (const id of parents) expanded.add(id);
    const found = new Set<string>();
    for (const kind of lineage_LINEAGE_EDGE_KINDS) {
      for (const id of await lineage_childIdsOf(db, scope, kind, parents, lineage_LINEAGE_MAX_NODES + 1)) found.add(id);
    }
    const fresh = [...found].filter((id) => !rows.has(id)).sort();
    if (depth === lineage_LINEAGE_MAX_DEPTH) { truncated ||= fresh.length > 0; break; }
    const room = lineage_LINEAGE_MAX_NODES - size();
    if (fresh.length > room) truncated = true;
    for (const row of await lineage_sessionsNamed(db, scope, fresh.slice(0, room))) rows.set(row.session_id, row);
    parents = [...found].filter((id) => rows.has(id) && !expanded.has(id));
  }

  const edges = [...rows.values()].flatMap(lineage_parentEdges).filter((edge) => rows.has(edge.parentId) || uncaptured.has(edge.parentId));
  return { nodes: lineage_placed(rows, uncaptured, edges, roots, sessionId), edges, truncated };
}

/** The sessions of the lineage no edge within it leads to. A lineage that is all cycle is rooted at the session read. */
function lineage_rootsOf(rows: ReadonlyMap<string, lineage_Row>, uncaptured: ReadonlySet<string>, sessionId: string): string[] {
  const held = (id: string) => rows.has(id) || uncaptured.has(id);
  const roots = [...uncaptured, ...[...rows.values()].filter((row) => !lineage_parentEdges(row).some((edge) => held(edge.parentId))).map((row) => row.session_id)];
  return roots.length === 0 ? [sessionId] : roots;
}

/** Each session placed once, under the first edge a breadth-first walk from the roots reaches it by, in tree order. */
function lineage_placed(rows: ReadonlyMap<string, lineage_Row>, uncaptured: ReadonlySet<string>, edges: readonly lineage_LineageEdge[], roots: readonly string[], sessionId: string): lineage_LineageNode[] {
  const node = (id: string, depth: number, placedUnder: lineage_LineageEdge | null): lineage_LineageNode => {
    const row = rows.get(id);
    return row === undefined
      ? { sessionId: id, captured: false, label: null, agent: null, startedAt: null, endedAt: null, depth, placedUnder, current: false }
      : {
        sessionId: id, captured: true, label: sessions_relatedSessionLabel(row.title, row.first_prompt, row.agent), agent: row.agent,
        startedAt: row.started_at, endedAt: row.ended_at, depth, placedUnder, current: id === sessionId,
      };
  };
  const childEdges = new Map<string, lineage_LineageEdge[]>();
  for (const edge of edges) childEdges.set(edge.parentId, [...childEdges.get(edge.parentId) ?? [], edge]);
  const under = new Map<string, lineage_LineageNode[]>();
  const seen = new Set<string>();
  const top = roots.map((id) => node(id, 0, null)).sort(lineage_byStart);
  for (const root of top) seen.add(root.sessionId);
  let level = top;
  while (level.length > 0) {
    const next: lineage_LineageNode[] = [];
    for (const parent of level) {
      const children: lineage_LineageNode[] = [];
      for (const edge of childEdges.get(parent.sessionId) ?? []) {
        if (seen.has(edge.childId)) continue;
        seen.add(edge.childId);
        children.push(node(edge.childId, parent.depth + 1, edge));
      }
      children.sort(lineage_byStart);
      under.set(parent.sessionId, children);
      next.push(...children);
    }
    level = next;
  }
  const out: lineage_LineageNode[] = [];
  const visit = (n: lineage_LineageNode) => { out.push(n); for (const child of under.get(n.sessionId) ?? []) visit(child); };
  for (const root of top) visit(root);
  return out;
}

export {
  lineage_LINEAGE_MAX_NODES,
  type lineage_SessionLineage,
  lineage_sessionLineage,
};
