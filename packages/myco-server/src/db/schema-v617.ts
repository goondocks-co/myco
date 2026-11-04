/** Work queues exclude sessions whose card and learning counters are settled. */
export const LEARNING_WORK_INDEX_STEPS = [
  `CREATE INDEX IF NOT EXISTS idx_learning_source_pending ON learning_sessions (project_id,source_activity_at DESC,session_id)
    WHERE pending_cards > 0`,
  `CREATE INDEX IF NOT EXISTS idx_learning_source_waiting ON learning_sessions (project_id,source_activity_at DESC,session_id)
    WHERE pending_cards > 0 OR due_cards > 0`,
].map((sql, index) => ({ version: 617 + index, statements: [sql] }));
