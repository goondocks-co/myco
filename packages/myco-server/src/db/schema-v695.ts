export const V695_STATEMENTS: readonly string[] = [
  "DELETE FROM schema_meta WHERE key IN ('learning_paused_at','learning_resumed_at')",
  "CREATE INDEX IF NOT EXISTS idx_turn_cards_session_pending ON turn_cards(project_id,session_id) WHERE state = 'pending'",
];
