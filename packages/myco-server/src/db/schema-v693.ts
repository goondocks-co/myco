/** Curation keeps revision-bound pair decisions and bounded discovery checkpoints. */
export const V693_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_spores_curation_seek ON spores (project_id,COALESCE(updated_at,created_at),id,revision) WHERE status='active'`,
  `CREATE INDEX IF NOT EXISTS idx_curation_projects ON project_capabilities (capability,enabled,project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_curation_runs_day ON agent_runs (project_id,task,started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_curation_resolution_author ON resolution_events (project_id,author,spore_id)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_cursor (project_id TEXT PRIMARY KEY REFERENCES projects(project_id), after_at INTEGER NOT NULL DEFAULT 0, after_id TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS spore_curation_clock (id INTEGER PRIMARY KEY CHECK(id=1), after_project TEXT NOT NULL DEFAULT '')`,
  `INSERT OR IGNORE INTO spore_curation_clock(id) VALUES(1)`,
  `CREATE TABLE IF NOT EXISTS spore_curation_work (
    project_id TEXT NOT NULL REFERENCES projects(project_id), pair_key TEXT NOT NULL,
    left_id TEXT NOT NULL, left_revision INTEGER NOT NULL, right_id TEXT NOT NULL, right_revision INTEGER NOT NULL,
    due_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, run_id TEXT,
    decision TEXT CHECK(decision IN ('keep','resolved','changed')), reason TEXT, decided_at INTEGER,
    PRIMARY KEY(project_id,pair_key), CHECK(left_id < right_id),
    CHECK(decision NOT IN ('keep','resolved') OR (reason IS NOT NULL AND length(trim(reason))>0 AND decided_at IS NOT NULL AND run_id IS NOT NULL)))`,
  `CREATE INDEX IF NOT EXISTS idx_curation_evidence ON spore_curation_work (project_id,run_id,decision)`,
  `CREATE INDEX IF NOT EXISTS idx_curation_due ON spore_curation_work (project_id,due_at,pair_key) WHERE due_at IS NOT NULL`,
];
