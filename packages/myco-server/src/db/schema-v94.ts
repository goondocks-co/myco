/** Tool result provenance and the immutable order of session activity. */
export const V94_STATEMENTS: readonly string[] = [
  `ALTER TABLE tool_calls ADD COLUMN result_reason TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_activity ON tool_calls (project_id, session_id, created_at, tool_call_id)`,
];
