import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const NEXT_S4B = 746;

/**
 * Lineage edges: one row per source, successor and action with its newest event, written by a trigger on new resolution events and filled for held
 * events by the shared catch-up. Frozen beside the runtime reconcile in db/spores/edges.ts.
 */
export const VNEXT_S4B_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S4B, statements: [
    `CREATE TABLE IF NOT EXISTS spore_resolution_edges(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),source_id TEXT NOT NULL,target_id TEXT NOT NULL,action TEXT NOT NULL,last_event_at INTEGER NOT NULL,last_event_id TEXT NOT NULL,
      PRIMARY KEY(project_id,source_id,target_id,action)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_spore_edges_successors ON spore_resolution_edges(project_id,source_id,action,last_event_at DESC,last_event_id DESC)',
    'CREATE INDEX IF NOT EXISTS idx_spore_edges_predecessors ON spore_resolution_edges(project_id,target_id,last_event_at DESC,last_event_id DESC)',
    `CREATE TRIGGER IF NOT EXISTS spore_resolution_edge_insert AFTER INSERT ON resolution_events WHEN NEW.new_spore_id IS NOT NULL BEGIN
      INSERT INTO spore_resolution_edges(project_id,source_id,target_id,action,last_event_at,last_event_id) VALUES(NEW.project_id,NEW.spore_id,NEW.new_spore_id,NEW.action,NEW.created_at,NEW.id)
      ON CONFLICT(project_id,source_id,target_id,action) DO UPDATE SET last_event_at=excluded.last_event_at,last_event_id=excluded.last_event_id
      WHERE (excluded.last_event_at,excluded.last_event_id) > (spore_resolution_edges.last_event_at,spore_resolution_edges.last_event_id); END`,
    "INSERT INTO projection_catchup(projection,phase,done) SELECT 'spore_resolution_edges','sporeResolutionEdges',NOT EXISTS(SELECT 1 FROM resolution_events) ON CONFLICT DO NOTHING",
  ] },
];
