import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { curationChangeSql } from './curation-changes.js';

/** Bounded seed discovery and run-selected final groups retain revision-bound outcomes. */
export const V693_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_spores_curation_seek ON spores (project_id,COALESCE(updated_at,created_at),id,revision) WHERE status='active'`,
  `CREATE INDEX IF NOT EXISTS idx_curation_projects ON project_capabilities (capability,enabled,project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_curation_runs_day ON agent_runs (project_id,task,started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_curation_resolution_author ON resolution_events (project_id,author,spore_id)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_work (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id), cluster_key TEXT NOT NULL, members TEXT NOT NULL CHECK(json_valid(members)), final_members TEXT CHECK(final_members IS NULL OR json_valid(final_members)),
    due_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, read_bytes INTEGER NOT NULL DEFAULT 0, run_id TEXT, close_token TEXT,
    decision TEXT CHECK(decision IN ('keep','resolved','changed','failed','oversized')), reason TEXT, decided_at INTEGER,
    PRIMARY KEY(project_id,cluster_key),
    CHECK(decision IS NULL OR (reason IS NOT NULL AND length(trim(reason))>0 AND decided_at IS NOT NULL)))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_due ON spore_curation_work(project_id,due_at,cluster_key) WHERE due_at IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_curation_evidence ON spore_curation_work(project_id,run_id,decision)',
  `CREATE TABLE IF NOT EXISTS spore_curation_owners (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), spore_id TEXT NOT NULL, cluster_key TEXT NOT NULL,
    PRIMARY KEY(project_id,spore_id), FOREIGN KEY(project_id,cluster_key) REFERENCES spore_curation_work(project_id,cluster_key))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_owners_cluster ON spore_curation_owners(project_id,cluster_key)',
  `CREATE TABLE IF NOT EXISTS spore_curation_receipts (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}), spore_id TEXT NOT NULL, revision INTEGER NOT NULL, cluster_key TEXT NOT NULL,
    PRIMARY KEY(project_id,spore_id), FOREIGN KEY(project_id,cluster_key) REFERENCES spore_curation_work(project_id,cluster_key))`,
  'CREATE INDEX IF NOT EXISTS idx_curation_receipts_cluster ON spore_curation_receipts(project_id,cluster_key)',
  `CREATE TABLE IF NOT EXISTS spore_curation_candidates (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id), run_id TEXT NOT NULL,
    spore_id TEXT NOT NULL, revision INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id,run_id,spore_id),
    FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_cursor (project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id), after_at INTEGER NOT NULL DEFAULT 0,
    after_id TEXT NOT NULL DEFAULT '', pass_revision INTEGER NOT NULL DEFAULT -1, active INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_clock (id INTEGER PRIMARY KEY CHECK(id=1), after_project TEXT NOT NULL DEFAULT '')`,
  `INSERT OR IGNORE INTO spore_curation_clock(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_changes (project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id), revision INTEGER NOT NULL, dirty INTEGER NOT NULL, pending_at INTEGER)`,
  'CREATE INDEX IF NOT EXISTS idx_curation_changes_due ON spore_curation_changes(dirty,project_id)',
  `INSERT INTO spore_curation_changes SELECT project_id,1,1,0 FROM project_capabilities WHERE capability='spore_curation' AND enabled=1`,
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_capability_${op.toLowerCase()} AFTER ${op} ON project_capabilities
    WHEN ${op === 'DELETE' ? 'OLD' : 'NEW'}.capability IN ('spore_curation','spore_curation_backfill') BEGIN ${curationChangeSql(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`, '0')} END`),
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_spore_${op.toLowerCase()} AFTER ${op === 'UPDATE' ? 'UPDATE OF revision,created_at,updated_at' : op} ON spores
    BEGIN ${curationChangeSql(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`, `COALESCE(${op === 'DELETE' ? 'OLD' : 'NEW'}.updated_at,${op === 'DELETE' ? 'OLD' : 'NEW'}.created_at)`)} END`),
  ...(['INSERT','UPDATE','DELETE'] as const).map(op => `CREATE TRIGGER IF NOT EXISTS curation_vector_${op.toLowerCase()} AFTER ${op === 'UPDATE' ? 'UPDATE OF project_id,model_key,id,record_id,revision,ready,updated_at,neighbor_mean,neighbor_std' : op} ON embedding_receipts
    WHEN ${op === 'DELETE' ? 'OLD' : 'NEW'}.type='spore' ${op==='UPDATE'?`AND (${['project_id','model_key','id','record_id','revision','ready','updated_at'].map(field=>`NEW.${field} IS NOT OLD.${field}`).join(' OR ')} OR
      ((OLD.neighbor_mean IS NULL OR OLD.neighbor_std IS NULL) AND NEW.neighbor_mean IS NOT NULL AND NEW.neighbor_std IS NOT NULL))`:''} BEGIN ${curationChangeSql(`${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id`, `COALESCE((SELECT COALESCE(updated_at,created_at) FROM spores WHERE project_id=${op === 'DELETE' ? 'OLD' : 'NEW'}.project_id AND id=${op === 'DELETE' ? 'OLD' : 'NEW'}.record_id),${op === 'DELETE' ? 'OLD' : 'NEW'}.updated_at)`)} END`),
  `CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id), leaf TEXT NOT NULL, value TEXT NOT NULL,
    updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY(project_id,leaf))`,
];
