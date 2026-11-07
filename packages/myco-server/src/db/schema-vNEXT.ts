/**
 * Lists across Projects order by an instant, the Project and the row's id, and their cursors carry all three, so rows
 * of different Projects sharing an instant and an id keep their own places across a page boundary. Each Deployment-wide
 * index is replaced under its own name with the Project between the instant and the id, so a page still walks it with
 * no sort.
 */
export const NEXT = 713;

export const VNEXT_STATEMENTS: readonly string[] = [
  'DROP INDEX IF EXISTS idx_sessions_occurred_deployment',
  'CREATE INDEX IF NOT EXISTS idx_sessions_occurred_deployment ON sessions (COALESCE(occurred_started_at, started_at, first_received_at), project_id, session_id)',
  'DROP INDEX IF EXISTS idx_plans_updated_deployment',
  'CREATE INDEX IF NOT EXISTS idx_plans_updated_deployment ON plans (updated_at, project_id, plan_key)',
  'DROP INDEX IF EXISTS idx_events_token_only',
  'CREATE INDEX IF NOT EXISTS idx_events_token_only ON events (token_id, created_at, project_id, event_id)',
];
