import { pendingCardsSql } from './learning-progress.js';

export const V695_STATEMENTS: readonly string[] = [
  "DELETE FROM schema_meta WHERE key IN ('learning_paused_at','learning_resumed_at')",
  "CREATE INDEX IF NOT EXISTS idx_turn_cards_session_pending ON turn_cards(project_id,session_id) WHERE state = 'pending'",
  'DROP TRIGGER IF EXISTS turn_cards_pending_count',
  `CREATE TRIGGER turn_cards_pending_count AFTER UPDATE OF state ON turn_cards WHEN OLD.state <> NEW.state BEGIN
    UPDATE learning_sessions SET pending_cards = ${pendingCardsSql('NEW.project_id', 'NEW.session_id')},
      eligible_at = CASE WHEN NEW.state = 'pending' THEN NULL ELSE eligible_at END
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
];
