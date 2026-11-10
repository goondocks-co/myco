import { reaching, type Reach, type DeploymentIndex } from './schema-step.js';
/** Unnamed-head classification seeks only its machine's unnamed sessions; named delete/rename paths require the same treatment. */
export const V707_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_unnamed_machine ON sessions(machine_id) WHERE agent IS NULL",
];

/** Why the step reaches tables earlier steps created. */
export const V707_REACHES: readonly Reach[] = reaching(['sessions'], 'Unnamed-head classification seeks only the machine’s unnamed sessions.');

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V707_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_sessions_unnamed_machine', read: 'capture-head classification seeks a machine\'s unnamed sessions before assigning the harness' },
];
