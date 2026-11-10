import { reaching, type Reach, type DeploymentIndex } from './schema-step.js';
/**
 * Lists across Projects order by an instant, the row's id and then its Project, and their cursors carry all three, so
 * rows of different Projects sharing an instant and an id keep their own places across a page boundary. Each
 * Deployment-wide index is replaced under its own name with the Project after the id, so a page still walks it with no
 * sort.
 */
export const V713 = 713;

export const V713_STATEMENTS: readonly string[] = [
  'DROP INDEX IF EXISTS idx_sessions_occurred_deployment',
  'CREATE INDEX IF NOT EXISTS idx_sessions_occurred_deployment ON sessions (COALESCE(occurred_started_at, started_at, first_received_at), session_id, project_id)',
  'DROP INDEX IF EXISTS idx_plans_updated_deployment',
  'CREATE INDEX IF NOT EXISTS idx_plans_updated_deployment ON plans (updated_at, plan_key, project_id)',
  'DROP INDEX IF EXISTS idx_events_token_only',
  'CREATE INDEX IF NOT EXISTS idx_events_token_only ON events (token_id, created_at, event_id, project_id)',
];

/** Why the step reaches tables earlier steps created. */
export const V713_REACHES: readonly Reach[] = reaching(['sessions', 'plans', 'events'], 'Each Deployment-wide list index is replaced under its own name with the Project after the id. Lists across Projects order by the instant, the id and the Project, and walk this index with no sort.');

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V713_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_events_token_only', read: 'a credential\'s events are counted by token across its Projects' },
  { index: 'idx_plans_updated_deployment', read: 'the plans list spans every Project, most recently updated first' },
];
