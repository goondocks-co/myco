import { reaching, type Reach, changing } from './schema-step.js';
export const V695_STATEMENTS: readonly string[] = [
  "DELETE FROM schema_meta WHERE key IN ('learning_paused_at','learning_resumed_at')",
  "CREATE INDEX IF NOT EXISTS idx_turn_cards_session_pending ON turn_cards(project_id,session_id) WHERE state = 'pending'",
];

/** Why the step reaches tables earlier steps created. */
export const V695_REACHES: readonly Reach[] = [
  ...changing(['schema_meta'], 'Retired pause markers are removed.'),
  ...reaching(['turn_cards'], 'Pending recounts seek only the pending rows of one session.'),
];
