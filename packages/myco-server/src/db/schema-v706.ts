import { reaching, type Reach, type DeploymentIndex } from './schema-step.js';
/** Machine pages seek each worker credential's latest run. */
export const V706_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_agent_runs_worker_started ON agent_runs(leased_by,started_at DESC)",
];

/** Why the step reaches tables earlier steps created. */
export const V706_REACHES: readonly Reach[] = reaching(['agent_runs'], 'Machine reads seek the latest run for each worker credential.');

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V706_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_agent_runs_worker_started', read: 'Health seeks the most recent start leased to each worker credential' },
];
