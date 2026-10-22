/** The session that started a session, beside the one it continues, and the child reads over both parent columns: each index holds only live sessions that name a parent (a deleted session's own parents are cleared first, as deletion clears them), so a parentless or deleted session writes no index row, and orders them by child id under each parent. */
export const V96_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN launch_parent_session_id TEXT`,
  `UPDATE sessions SET parent_session_id = NULL, parent_reason = NULL
     WHERE (parent_session_id IS NOT NULL OR parent_reason IS NOT NULL)
       AND EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = sessions.project_id AND t.session_id = sessions.session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (project_id, parent_session_id, session_id) WHERE parent_session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_launch_parent ON sessions (project_id, launch_parent_session_id, session_id) WHERE launch_parent_session_id IS NOT NULL`,
];
