import { reaching, type Reach, type DeploymentIndex } from './schema-step.js';
/** Credential-owned sessions for first-context measurements. */
export const V702_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_credential ON sessions(created_by_token_id,project_id,session_id)",
];

/** Why the step reaches tables earlier steps created. */
export const V702_REACHES: readonly Reach[] = reaching(['sessions'], 'First-context measurements seek the sessions attributed to each credential.');

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V702_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_sessions_credential', read: 'Health seeks the sessions created by each credential to measure its first context' },
];
