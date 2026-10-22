import type { RelationalStore } from '../core/adapters.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { inListChunks, type ReadScope } from './scope.js';
import { FIRST_PROMPT_SQL, PRESENTED_ENDED_AT, PRESENTED_STARTED_AT, relatedSessionLabel } from './sessions.js';

/** The most generations the walk climbs above the session, and descends below the root it reached. */
export const LINEAGE_MAX_DEPTH = 8;
/** The most sessions one lineage holds, the session itself and its ancestors included. */
export const LINEAGE_MAX_NODES = 200;

/** `launched`: the parent started the child (`launch_parent_session_id`). `continuation`: the child continues the parent's conversation under a new id (`parent_session_id`). */
export const LINEAGE_EDGE_KINDS = ['launched', 'continuation'] as const;
export type LineageEdgeKind = (typeof LINEAGE_EDGE_KINDS)[number];

export interface LineageEdge {
  parentId: string;
  childId: string;
  kind: LineageEdgeKind;
  /** The continuation's recorded reason; null for a launch. */
  reason: string | null;
}

export interface LineageNode {
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
  placedUnder: LineageEdge | null;
  current: boolean;
}

export interface SessionLineage {
  /** Every session of the lineage in tree order: each root, then what is placed under it, children by start. */
  nodes: LineageNode[];
  /** Every edge between two sessions of the lineage, both kinds. */
  edges: LineageEdge[];
  /** True when a bound stopped the walk with sessions left unread. */
  truncated: boolean;
}

interface Row {
  session_id: string;
  agent: string | null;
  title: string | null;
  first_prompt: string | null;
  started_at: number | null;
  ended_at: number | null;
  parent_session_id: string | null;
  parent_reason: string | null;
  launch_parent_session_id: string | null;
}

const LINEAGE_COLUMNS = `s.session_id, s.agent, s.title, ${FIRST_PROMPT_SQL} AS first_prompt, ${PRESENTED_STARTED_AT} AS started_at,
  ${PRESENTED_ENDED_AT} AS ended_at, s.parent_session_id, s.parent_reason, s.launch_parent_session_id`;
const LIVE = notTombstonedSql('s');

/** The column that names each edge kind's parent. */
const PARENT_COLUMN: Record<LineageEdgeKind, 'launch_parent_session_id' | 'parent_session_id'> = {
  launched: 'launch_parent_session_id',
  continuation: 'parent_session_id',
};
/** The index each parent column's children are read through, named: it holds the parent and the child's id, so it supplies the order a bounded selection stops in. */
export const CHILDREN_INDEX: Record<LineageEdgeKind, string> = {
  launched: 'idx_sessions_launch_parent',
  continuation: 'idx_sessions_parent',
};

/** A row's parents as edges, launch first. */
function parentEdges(row: Row): LineageEdge[] {
  return LINEAGE_EDGE_KINDS.flatMap((kind) => {
    const parentId = row[PARENT_COLUMN[kind]];
    return parentId === null || parentId === row.session_id ? [] : [{ parentId, childId: row.session_id, kind, reason: kind === 'continuation' ? row.parent_reason : null }];
  });
}

const byStart = (a: { startedAt: number | null; sessionId: string }, b: { startedAt: number | null; sessionId: string }): number =>
  (a.startedAt ?? Number.MAX_SAFE_INTEGER) - (b.startedAt ?? Number.MAX_SAFE_INTEGER) || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);

/** The live sessions this Project holds among `ids`. */
async function sessionsNamed(db: RelationalStore, scope: ReadScope, ids: readonly string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const run of inListChunks(ids)) {
    const { results } = await db.prepare(`SELECT ${LINEAGE_COLUMNS} FROM sessions s
        WHERE s.project_id = ? AND s.session_id IN (${run.map(() => '?').join(', ')}) AND ${LIVE}`)
      .bind(scope.projectId, ...run).all<Row>();
    out.push(...results);
  }
  return out;
}

/**
 * The ids of at most `limit` live sessions of this Project whose `kind` parent is one of `ids`, in the index's own order
 * (parent, then child id), so the read stops at the limit whatever the family's size.
 */
async function childIdsOf(db: RelationalStore, scope: ReadScope, kind: LineageEdgeKind, ids: readonly string[], limit: number): Promise<string[]> {
  const out: string[] = [];
  const column = PARENT_COLUMN[kind];
  for (const run of inListChunks([...ids].sort())) {
    if (out.length >= limit) break;
    const { results } = await db.prepare(`SELECT s.session_id FROM sessions s INDEXED BY ${CHILDREN_INDEX[kind]}
        WHERE s.project_id = ? AND s.${column} IN (${run.map(() => '?').join(', ')}) AND ${LIVE}
        ORDER BY s.${column}, s.session_id LIMIT ?`)
      .bind(scope.projectId, ...run, limit - out.length).all<{ session_id: string }>();
    out.push(...results.map((row) => row.session_id));
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
export async function sessionLineage(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<SessionLineage | null> {
  const [self] = await sessionsNamed(db, scope, [sessionId]);
  if (self === undefined) return null;
  const rows = new Map<string, Row>([[sessionId, self]]);
  const uncaptured = new Set<string>();
  const size = () => rows.size + uncaptured.size;
  let truncated = false;

  // Up: the parents of each generation, until none is named or held.
  let frontier = [self];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const named = [...new Set(frontier.flatMap(parentEdges).map((edge) => edge.parentId))]
      .filter((id) => !rows.has(id) && !uncaptured.has(id));
    if (named.length === 0) break;
    if (depth === LINEAGE_MAX_DEPTH || size() + named.length > LINEAGE_MAX_NODES) { truncated = true; break; }
    const found = await sessionsNamed(db, scope, named);
    for (const row of found) rows.set(row.session_id, row);
    for (const id of named) if (!rows.has(id)) uncaptured.add(id);
    frontier = found;
  }

  // Down: the children of each generation, from the sessions no edge in the lineage leads to. A session held from the
  // walk up is walked down too, once. Each generation selects child ids within the bound, then reads only the kept ones.
  const roots = rootsOf(rows, uncaptured, sessionId);
  const expanded = new Set<string>();
  let parents = roots;
  for (let depth = 0; parents.length > 0; depth += 1) {
    for (const id of parents) expanded.add(id);
    const found = new Set<string>();
    for (const kind of LINEAGE_EDGE_KINDS) {
      for (const id of await childIdsOf(db, scope, kind, parents, LINEAGE_MAX_NODES + 1)) found.add(id);
    }
    const fresh = [...found].filter((id) => !rows.has(id)).sort();
    if (depth === LINEAGE_MAX_DEPTH) { truncated ||= fresh.length > 0; break; }
    const room = LINEAGE_MAX_NODES - size();
    if (fresh.length > room) truncated = true;
    for (const row of await sessionsNamed(db, scope, fresh.slice(0, room))) rows.set(row.session_id, row);
    parents = [...found].filter((id) => rows.has(id) && !expanded.has(id));
  }

  const edges = [...rows.values()].flatMap(parentEdges).filter((edge) => rows.has(edge.parentId) || uncaptured.has(edge.parentId));
  return { nodes: placed(rows, uncaptured, edges, roots, sessionId), edges, truncated };
}

/** The sessions of the lineage no edge within it leads to. A lineage that is all cycle is rooted at the session read. */
function rootsOf(rows: ReadonlyMap<string, Row>, uncaptured: ReadonlySet<string>, sessionId: string): string[] {
  const held = (id: string) => rows.has(id) || uncaptured.has(id);
  const roots = [...uncaptured, ...[...rows.values()].filter((row) => !parentEdges(row).some((edge) => held(edge.parentId))).map((row) => row.session_id)];
  return roots.length === 0 ? [sessionId] : roots;
}

/** Each session placed once, under the first edge a breadth-first walk from the roots reaches it by, in tree order. */
function placed(rows: ReadonlyMap<string, Row>, uncaptured: ReadonlySet<string>, edges: readonly LineageEdge[], roots: readonly string[], sessionId: string): LineageNode[] {
  const node = (id: string, depth: number, placedUnder: LineageEdge | null): LineageNode => {
    const row = rows.get(id);
    return row === undefined
      ? { sessionId: id, captured: false, label: null, agent: null, startedAt: null, endedAt: null, depth, placedUnder, current: false }
      : {
        sessionId: id, captured: true, label: relatedSessionLabel(row.title, row.first_prompt, row.agent), agent: row.agent,
        startedAt: row.started_at, endedAt: row.ended_at, depth, placedUnder, current: id === sessionId,
      };
  };
  const childEdges = new Map<string, LineageEdge[]>();
  for (const edge of edges) childEdges.set(edge.parentId, [...childEdges.get(edge.parentId) ?? [], edge]);
  const under = new Map<string, LineageNode[]>();
  const seen = new Set<string>();
  const top = roots.map((id) => node(id, 0, null)).sort(byStart);
  for (const root of top) seen.add(root.sessionId);
  let level = top;
  while (level.length > 0) {
    const next: LineageNode[] = [];
    for (const parent of level) {
      const children: LineageNode[] = [];
      for (const edge of childEdges.get(parent.sessionId) ?? []) {
        if (seen.has(edge.childId)) continue;
        seen.add(edge.childId);
        children.push(node(edge.childId, parent.depth + 1, edge));
      }
      children.sort(byStart);
      under.set(parent.sessionId, children);
      next.push(...children);
    }
    level = next;
  }
  const out: LineageNode[] = [];
  const visit = (n: LineageNode) => { out.push(n); for (const child of under.get(n.sessionId) ?? []) visit(child); };
  for (const root of top) visit(root);
  return out;
}
