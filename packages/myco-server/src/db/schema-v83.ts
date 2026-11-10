import type { DeploymentIndex } from './schema-step.js';
import { READ_BUDGET_SESSION_STATEMENTS } from './read-budget-session-statements.js';

/** History-independent retention selection and activity extrema. */
export const V83_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_retention ON agent_runs(resumable, COALESCE(completed_at, started_at), id)
    WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_activity ON agent_runs(started_at)`,
  ...READ_BUDGET_SESSION_STATEMENTS,
];

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V83_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_agent_runs_retention', read: 'run retention seeks eligible terminal runs across the Deployment by cutoff and id' },
  { index: 'idx_agent_runs_activity', read: 'power resolution seeks the newest run start across the Deployment' },
];
