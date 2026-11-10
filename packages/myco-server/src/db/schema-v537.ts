import type { DeploymentIndex } from './schema-step.js';
/** A backup upload retains release authority until index publication or expiry. */
export const V537_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS backup_publications (
    key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_backup_publications_expiry ON backup_publications(expires_at,key)',
];

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V537_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_backup_publications_expiry', read: 'the object-release drain consumes expired backup publication authorities across the Deployment, oldest expiry first' },
];
