import { READ_BUDGET_SESSION_STATEMENTS } from './read-budget-session-statements.js';

/** History-independent retention selection and activity extrema. */
export const V83_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_retention ON agent_runs(resumable, COALESCE(completed_at, started_at), id)
    WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(last_received_at)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_activity ON agent_runs(started_at)`,
  ...READ_BUDGET_SESSION_STATEMENTS,
];
