import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { contextValue } from './run-context.js';

/**
 * Schema v58: the sessions a run read.
 *
 * - `run_reads` holds one row per run and session its run tools served it: a titling run's own session material, and
 *   the sessions whose prompt bodies an extraction page carried. The key is the pair, so a run that reads a session
 *   twice holds one row, stamped when it first read it. `token_id` is the run credential that read it.
 *   A row goes with its run (`ON DELETE CASCADE`, so run retention takes it) and with its session's deletion, which
 *   removes it beside the session's other derived rows. The primary key serves the run's foreign key and the per-run
 *   reads; `idx_run_reads_session` serves the session's foreign key and the runs that read one session.
 * - `idx_spores_session` finds the spores written from one session, and serves the foreign key `spores` has always
 *   carried to `sessions`.
 * - `idx_agent_runs_session` finds the runs whose dispatch named one session (a titling run's own), on the same
 *   expression every statement reads the context's `session_id` with.
 */
export const V58_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_reads (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id      TEXT NOT NULL,
     session_id  TEXT NOT NULL,
     token_id    TEXT NOT NULL,
     received_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, run_id, session_id),
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE CASCADE,
     FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS idx_run_reads_session ON run_reads (project_id, session_id, received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_spores_session ON spores (project_id, session_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs (project_id, ${contextValue('session_id')})`,
];
