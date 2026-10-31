import { TURN_QUIET_MS } from './schema-v110.js';

/** The `schema-v110` triggers that derived card and learning state from the legacy content tables and the views. */
export const V110_LEGACY_TRIGGERS: readonly string[] = [
  'prompt_batches_learning_session', 'prompt_batches_turn_card_open', 'prompt_batches_turn_card_insert', 'prompt_batches_turn_card_update',
  'responses_turn_card_insert', 'tool_calls_turn_card_insert', 'tool_calls_turn_card_update', 'plans_turn_card_insert',
  'plans_turn_card_update', 'session_views_learning_insert', 'session_views_learning_update',
];

const live = `FROM session_documents d WHERE d.state = 'live'
    AND NOT EXISTS (SELECT 1 FROM session_tombstones x WHERE x.project_id = d.project_id AND x.session_id = d.session_id)`;

/**
 * Learning reads documents. The publisher becomes the one writer of card state: the legacy triggers go, and a pending
 * card waits for settlement (`settle_at`) before a model may be asked for it (`due_at`). Every turn of a live document
 * gets its card row and every live session its learning row, ready. A session's title records the user prompts its
 * document held at its writing, so a refresh is due by counting rather than by reading prompts.
 */
export const V115_STATEMENTS: readonly string[] = [
  ...V110_LEGACY_TRIGGERS.map((name) => `DROP TRIGGER IF EXISTS ${name}`),
  `ALTER TABLE turn_cards ADD COLUMN settle_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_settle ON turn_cards (settle_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_model_due ON turn_cards (project_id, session_id, created_at)
    WHERE state = 'pending' AND due_at IS NOT NULL`,
  `UPDATE turn_cards SET settle_at = COALESCE(due_at, created_at + ${TURN_QUIET_MS}), due_at = NULL WHERE state = 'pending'`,
  `INSERT OR IGNORE INTO turn_cards (project_id, session_id, turn_key, settle_at, created_at)
    SELECT p.project_id, p.session_id, p.prompt_id, p.created_at + ${TURN_QUIET_MS}, p.created_at ${live.replace('WHERE', `JOIN session_prompts p
      ON p.project_id = d.project_id AND p.session_id = d.session_id AND p.generation = d.generation AND p.turn_key = p.prompt_id WHERE`)}`,
  `INSERT OR IGNORE INTO learning_sessions (project_id, session_id) SELECT d.project_id, d.session_id ${live}`,
  `UPDATE learning_sessions SET init_state = 'ready', pending_cards = (SELECT COUNT(*) FROM turn_cards c
    WHERE c.project_id = learning_sessions.project_id AND c.session_id = learning_sessions.session_id AND c.state = 'pending')`,
  `UPDATE learning_sessions SET eligible_at = NULL WHERE pending_cards > 0`,
  `DELETE FROM learning_init_queue`,
  `ALTER TABLE sessions ADD COLUMN title_user_prompts INTEGER`,
  `UPDATE sessions SET title_user_prompts = (SELECT d.user_prompts FROM session_documents d
    WHERE d.project_id = sessions.project_id AND d.session_id = sessions.session_id AND d.state = 'live') WHERE title IS NOT NULL`,
];
