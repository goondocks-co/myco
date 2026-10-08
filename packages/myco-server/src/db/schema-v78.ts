/**
 * Titling of sessions that stay open or resume. `sessions.title_material_at` is the server-clock instant the standing
 * title's material is read from, written with the title; a refresh counts the prompts received after it. The partial
 * indexes serve the two candidate reads: open untitled sessions by silence, and titled sessions by recency.
 * `idx_prompt_batches_user_received` counts a session's user prompts by receipt.
 */
export const V78_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN title_material_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_untitled_open ON sessions (last_received_at)
    WHERE ended_at IS NULL AND title IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_titled_recent ON sessions (last_received_at)
    WHERE title IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_user_received ON prompt_batches (project_id, session_id, origin, received_at)`,
];
