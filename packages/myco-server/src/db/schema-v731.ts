export const V731 = 731;

/**
 * Run evidence: keyed attempt, call and received-step heads through the shared catch-up, the moved-body table, the
 * per-body move failures, the retirement marker and their triggers. Each index build over a history-sized table is a
 * step of its own after it.
 */
export const V731_STATEMENTS: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS run_head(project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),run_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,calls INTEGER NOT NULL DEFAULT 0,calls_failed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,run_id),FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS attempt_head(project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,received INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,run_id,attempt_id),FOREIGN KEY(project_id,run_id,attempt_id) REFERENCES agent_run_attempts(project_id,run_id,attempt_id) ON DELETE CASCADE) WITHOUT ROWID",
  "CREATE TABLE IF NOT EXISTS run_bodies(project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),run_id TEXT NOT NULL,body_kind TEXT NOT NULL,item_id INTEGER NOT NULL,key TEXT NOT NULL,size INTEGER NOT NULL,moved_at INTEGER NOT NULL,PRIMARY KEY(project_id,run_id,body_kind,item_id),FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id))",
  "CREATE INDEX IF NOT EXISTS idx_run_bodies_key ON run_bodies(project_id,key)",
  "CREATE TABLE IF NOT EXISTS run_body_failures(project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),run_id TEXT NOT NULL,body_kind TEXT NOT NULL,item_id INTEGER NOT NULL,failures INTEGER NOT NULL,error TEXT NOT NULL,first_failed_at INTEGER NOT NULL,retry_at INTEGER NOT NULL,PRIMARY KEY(project_id,run_id,body_kind,item_id),FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE) WITHOUT ROWID",
  "CREATE INDEX IF NOT EXISTS idx_run_body_failures_oldest ON run_body_failures(first_failed_at,project_id,run_id,body_kind,item_id)",
  "CREATE TABLE IF NOT EXISTS run_retirements(project_id TEXT NOT NULL CHECK (project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')),run_id TEXT NOT NULL,marked_at INTEGER NOT NULL,PRIMARY KEY(project_id,run_id),FOREIGN KEY(project_id,run_id) REFERENCES agent_runs(project_id,id) ON DELETE CASCADE) WITHOUT ROWID",
  "CREATE TRIGGER IF NOT EXISTS run_head_call_insert AFTER INSERT ON agent_run_events WHEN NEW.event_type='run_tool' BEGIN\n       INSERT INTO run_head(project_id,run_id,calls,calls_failed) VALUES(NEW.project_id,NEW.run_id,1,COALESCE(NEW.outcome='failed',0))\n       ON CONFLICT(project_id,run_id) DO UPDATE SET calls=run_head.calls+1,calls_failed=run_head.calls_failed+COALESCE(NEW.outcome='failed',0);\n     END",
  "CREATE TRIGGER IF NOT EXISTS run_head_call_delete AFTER DELETE ON agent_run_events WHEN OLD.event_type='run_tool' BEGIN\n       UPDATE run_head SET calls=MAX(0,calls-1),calls_failed=MAX(0,calls_failed-COALESCE(OLD.outcome='failed',0)) WHERE project_id=OLD.project_id AND run_id=OLD.run_id;\n     END",
  "CREATE TRIGGER IF NOT EXISTS run_head_attempt_insert AFTER INSERT ON agent_run_attempts BEGIN\n       INSERT INTO run_head(project_id,run_id,attempts) VALUES(NEW.project_id,NEW.run_id,1) ON CONFLICT(project_id,run_id) DO UPDATE SET attempts=run_head.attempts+1;\n     END",
  "CREATE TRIGGER IF NOT EXISTS run_head_attempt_delete AFTER DELETE ON agent_run_attempts BEGIN\n       UPDATE run_head SET attempts=MAX(0,attempts-1) WHERE project_id=OLD.project_id AND run_id=OLD.run_id;\n     END",
  "INSERT INTO projection_catchup(projection,phase,done) SELECT 'run_evidence','evidenceRuns',NOT EXISTS(SELECT 1 FROM agent_runs) ON CONFLICT DO NOTHING",
  "INSERT INTO projection_catchup(projection,phase,done) SELECT 'run_evidence','evidenceAttempts',NOT EXISTS(SELECT 1 FROM agent_run_attempts) ON CONFLICT DO NOTHING",
];

/** One index build per step, so a build that runs long on hosted storage does not share its step with other work; the served-material build drops the index it replaces. */
export const V731_INDEX_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: V731 + 1, statements: [
    "CREATE INDEX IF NOT EXISTS idx_agent_run_events_write ON agent_run_events(project_id,run_id,tool_name) WHERE event_type='run_write'",
  ] },
  { version: V731 + 2, statements: [
    "CREATE INDEX IF NOT EXISTS idx_run_served_material_session_record ON run_served_material(project_id,run_id,session_id,record_id,served_id)",
  "DROP INDEX IF EXISTS idx_run_served_material_session",
  ] },
  { version: V731 + 3, statements: [
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_body_due ON agent_runs(completed_at,project_id,id) WHERE status IN ('completed','failed','skipped') AND resumable=0 AND instruction IS NOT NULL AND length(CAST(instruction AS BLOB))>=4096",
  ] },
  { version: V731 + 4, statements: [
    "CREATE INDEX IF NOT EXISTS idx_agent_reports_body_due ON agent_reports(created_at,id) WHERE (details IS NOT NULL AND length(CAST(details AS BLOB))>=4096) OR (audit IS NOT NULL AND length(CAST(audit AS BLOB))>=4096)",
  ] },
];

/** The last of this family's steps. */
export const V735 = V731 + 4;
