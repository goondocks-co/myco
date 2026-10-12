/** Sub-agent attribution reads only the retained starts for a session. */
export const V85_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_events_subagent_start ON events (project_id, session_id) WHERE kind = 'subagent.start'`,
];
