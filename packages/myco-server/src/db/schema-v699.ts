/** Map freshness checks seek one Project's captures beyond its settled map. */
export const V699_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_project_capture ON sessions(project_id,last_received_at)',
];
