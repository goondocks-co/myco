import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { readSet, read, rows, write } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * The canonical lineage between spores: one row per source, successor and action, carrying its newest event.
 *
 * Resolution events stay the authority and are never rewritten. An edge is what browsing a spore's lineage reads, so a repeated import of the same history
 * costs one row and the page has a stable order. A trigger writes each new event's edge; catch-up replays events already held through the same upsert, which
 * only ever moves an edge forward, so replay and interleaving cannot lose or duplicate one. While catch-up runs, lineage reads answer from the events.
 */
const EDGE_PROJECTION = 'spore_resolution_edges';
const EDGE_PHASE = 'sporeResolutionEdges';

const UPSERT = `ON CONFLICT(project_id,source_id,target_id,action) DO UPDATE SET last_event_at=excluded.last_event_at,last_event_id=excluded.last_event_id
  WHERE (excluded.last_event_at,excluded.last_event_id) > (spore_resolution_edges.last_event_at,spore_resolution_edges.last_event_id)`;
const INSERT_EDGE = 'INSERT INTO spore_resolution_edges(project_id,source_id,target_id,action,last_event_at,last_event_id)';

export const SPORE_EDGE_CATCHUP = {
  projection: EDGE_PROJECTION,
  phases: { [EDGE_PHASE]: {
    source: { table: 'resolution_events', columns: ['project_id', 'id'], unique: true },
    reconcile: [write<[string]>({ name: 'sporeEdges.page', sql: `${INSERT_EDGE}
      SELECT e.project_id,e.spore_id,e.new_spore_id,e.action,e.created_at,e.id FROM (${jsonKeys(['project_id', 'id'])}) key
      JOIN resolution_events e ON e.project_id=key.project_id AND e.id=key.id WHERE e.new_spore_id IS NOT NULL ${UPSERT}` })],
  } },
} as const satisfies CatchupFamily;

const edgesReady = read<[], { done: number }>({ name: 'sporeEdges.ready', sql: `SELECT done FROM projection_catchup WHERE projection='${EDGE_PROJECTION}' AND phase='${EDGE_PHASE}'` });

const successors = read<[project: string, source: string, limit: number], { id: string }>({
  name: 'sporeEdges.successors',
  sql: `SELECT target_id AS id FROM spore_resolution_edges INDEXED BY idx_spore_edges_successors WHERE project_id=?1 AND source_id=?2 AND action='supersede' ORDER BY last_event_at DESC,last_event_id DESC LIMIT ?3`,
});
const predecessors = read<[project: string, target: string, limit: number], { id: string }>({
  name: 'sporeEdges.predecessors',
  sql: `SELECT source_id AS id FROM spore_resolution_edges INDEXED BY idx_spore_edges_predecessors WHERE project_id=?1 AND target_id=?2 AND action IN ('supersede','consolidate')
    GROUP BY source_id ORDER BY MAX(last_event_at) DESC,MAX(last_event_id) DESC LIMIT ?3`,
});
const eventSuccessors = read<[project: string, source: string, limit: number], { id: string }>({
  name: 'sporeEdges.eventSuccessors',
  sql: `SELECT new_spore_id AS id FROM resolution_events WHERE project_id=?1 AND spore_id=?2 AND action='supersede' AND new_spore_id IS NOT NULL
    GROUP BY new_spore_id ORDER BY MAX(created_at) DESC,MAX(id) DESC LIMIT ?3`,
});
const eventPredecessors = read<[project: string, target: string, limit: number], { id: string }>({
  name: 'sporeEdges.eventPredecessors',
  sql: `SELECT spore_id AS id FROM resolution_events WHERE project_id=?1 AND new_spore_id=?2 AND action IN ('supersede','consolidate')
    GROUP BY spore_id ORDER BY MAX(created_at) DESC,MAX(id) DESC LIMIT ?3`,
});

type LineageRead = typeof successors;

async function lineage(db: RelationalStore, scope: ReadScope, sporeId: string, limit: number, edge: LineageRead, event: LineageRead): Promise<string[]> {
  const [ready, listed] = await readSet(db, edgesReady.bind(), edge.bind(scope.projectId, sporeId, limit));
  const ids = ready[0]?.done === 1 ? listed : await rows(db, event.bind(scope.projectId, sporeId, limit));
  return ids.map(row => row.id);
}

/** Every spore recorded as superseding this one, newest first. */
export const listSupersedingSporeIds = (db: RelationalStore, scope: ReadScope, sporeId: string, limit = 10): Promise<string[]> =>
  lineage(db, scope, sporeId, limit, successors, eventSuccessors);

/** Every spore this one replaced, newest first: a supersede names one predecessor and a consolidate every source it merged. */
export const listSupersededSporeIds = (db: RelationalStore, scope: ReadScope, sporeId: string, limit = 10): Promise<string[]> =>
  lineage(db, scope, sporeId, limit, predecessors, eventPredecessors);
