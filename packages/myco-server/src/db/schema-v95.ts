import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** Deployment instant from which extraction citations require served material. */
export const LEDGER_ENABLED_AT = 'ledger_enabled_at';

/** Session citations and the material served to a run. */
export const V95_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_served_material (
     project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
     served_id TEXT NOT NULL,
     run_id TEXT NOT NULL,
     session_id TEXT NOT NULL,
     instance_id TEXT,
     record_id TEXT NOT NULL,
     source_transcript_id TEXT,
     source_offset INTEGER,
     source_end INTEGER,
     served_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, served_id),
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE CASCADE,
     FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_run_served_material_record ON run_served_material (project_id, run_id, record_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_served_material_session ON run_served_material (project_id, run_id, session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_run_served_material_session_delete ON run_served_material (project_id, session_id)`,
  `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('${LEDGER_ENABLED_AT}', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
];
