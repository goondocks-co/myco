/** Credential-owned sessions for first-context measurements. */
export const V702_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_credential ON sessions(created_by_token_id,project_id,session_id)",
];
