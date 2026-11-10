import type { DeploymentIndex } from './schema-step.js';
/** A machine's current provisioned harness facts. */
export const V67_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS machine_harness_reports (
     machine_id TEXT PRIMARY KEY,
     harnesses TEXT NOT NULL,
     reported_at INTEGER NOT NULL)`,
  `ALTER TABLE sessions ADD COLUMN last_live_received_at INTEGER`,
  `UPDATE sessions SET last_live_received_at = (
     SELECT MAX(e.received_at) FROM events e
     WHERE e.project_id = sessions.project_id AND e.session_id = sessions.session_id AND e.channel <> 'import')`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_harness_live ON sessions (machine_id, agent, last_live_received_at DESC)
     WHERE last_live_received_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_machine_live ON sessions (last_live_received_at, machine_id)
     WHERE last_live_received_at IS NOT NULL`,
];

/** The indexes this step creates that a Deployment-wide read seeks by, and the read each serves. */
export const V67_DEPLOYMENT_INDEXES: readonly DeploymentIndex[] = [
  { index: 'idx_sessions_harness_live', read: 'Health seeks the latest live capture of a provisioned machine and harness across every Project' },
  { index: 'idx_sessions_machine_live', read: 'Health reads recent live machine activity across every Project, including an unprovisioned harness' },
];
