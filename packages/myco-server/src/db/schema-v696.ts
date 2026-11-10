import { reaching, type Reach, type DeploymentIndex } from './schema-step.js';
/** Recent task-start counts seek only the admission window. */
export const V696_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_agent_runs_task_started ON agent_runs(task,started_at,id)',
];

/** Why the step reaches tables earlier steps created. */
export const V696_REACHES: readonly Reach[] = reaching(['agent_runs'], 'Claim admission seeks recent starts of one task across the Deployment.');

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V696_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_agent_runs_task_started', read: 'claim admission counts recent task starts across the Deployment' },
];
