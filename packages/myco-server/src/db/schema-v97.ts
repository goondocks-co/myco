import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** The plan metadata retained by a context receipt. */
export const V97_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS injection_served_items (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     receipt_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind = 'plan'),
     item_id TEXT NOT NULL,
     title TEXT,
     session_id TEXT,
     content_hash TEXT,
     unavailable INTEGER NOT NULL DEFAULT 0 CHECK (unavailable IN (0, 1)),
     PRIMARY KEY (project_id, receipt_id, kind, item_id))`,
  `CREATE INDEX IF NOT EXISTS idx_injection_served_items_source_session
     ON injection_served_items (project_id, session_id) WHERE session_id IS NOT NULL`,
];
