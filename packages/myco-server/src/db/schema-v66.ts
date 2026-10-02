import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Schema v66: what a run's agent says it did, and what its worker saw it do.
 *
 * - `agent_reports.audit` holds the structured account a report carries (`core/run-audit.ts`): the steps taken, the
 *   files and areas examined, the commands run, each failure with its recovery, and the reasoning behind the
 *   outcome. Null for a report that filed none.
 * - `agent_run_attempts` holds one row per claim of a run: the attempt (the run credential the claim minted), the
 *   worker credential and machine that took it, and when. The step log totals arrive with the worker's pages:
 *   `steps_total` steps observed, `steps_overflow` past the log's bound, and `unrecognized`, the stream records the
 *   worker could not read, counted by shape. A row goes with its run (`ON DELETE CASCADE`).
 * - `agent_run_steps` holds the step log one attempt's worker observed, one row per step: its action, the harness's
 *   tool name, its one target, its outcome and exit status, its start and end, and the harness's call id. It carries
 *   no file contents and no command output. A row goes with its attempt. The primary keys serve both foreign keys and
 *   every read, which is by run and attempt in step order.
 */
export const V66_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_reports ADD COLUMN audit TEXT`,
  `CREATE TABLE IF NOT EXISTS agent_run_attempts (
     project_id     TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id         TEXT NOT NULL,
     attempt_id     TEXT NOT NULL,
     leased_by      TEXT NOT NULL,
     machine_id     TEXT,
     claimed_at     INTEGER NOT NULL,
     steps_total    INTEGER,
     steps_overflow INTEGER,
     unrecognized   TEXT,
     PRIMARY KEY (project_id, run_id, attempt_id),
     FOREIGN KEY (project_id, run_id) REFERENCES agent_runs(project_id, id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS agent_run_steps (
     project_id  TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
     run_id      TEXT NOT NULL,
     attempt_id  TEXT NOT NULL,
     seq         INTEGER NOT NULL CHECK (seq >= 0),
     call_id     TEXT,
     kind        TEXT NOT NULL CHECK (kind IN ('read', 'search', 'edit', 'command', 'fetch', 'myco', 'tool')),
     tool        TEXT NOT NULL,
     target      TEXT,
     outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'refused', 'unfinished')),
     exit_code   INTEGER,
     started_at  INTEGER NOT NULL,
     ended_at    INTEGER,
     received_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, run_id, attempt_id, seq),
     FOREIGN KEY (project_id, run_id, attempt_id) REFERENCES agent_run_attempts(project_id, run_id, attempt_id) ON DELETE CASCADE)`,
];
