import { reaching, type Reach } from './schema-step.js';
import { LEARNING_RETRY_KEY } from './run-context.js';

const retry = (field: string) => `json_extract(NEW.run_context, '$.${LEARNING_RETRY_KEY}.${field}')`;
const session = `json_extract(NEW.run_context, '$.session_id')`;
const ownedRetry = `${retry('attemptId')} = NEW.dispatched_by`;

/** Sign-in failures release the retry reservation; ordinary task failures retain their backoff. */
export const V694_STATEMENTS: readonly string[] = [
  'DROP TRIGGER IF EXISTS card_run_retry',
  `CREATE TRIGGER IF NOT EXISTS card_run_retry AFTER UPDATE OF status ON agent_runs
    WHEN NEW.task = 'turn-cards' AND OLD.status IS NOT NEW.status AND NEW.status IN ('completed','failed')
      AND NEW.error_code IS NOT 'agent_not_signed_in' BEGIN
    UPDATE learning_sessions SET
      card_retry_at = CASE WHEN NEW.status = 'completed' THEN 0 ELSE COALESCE(NEW.completed_at,NEW.started_at) +
        CASE WHEN card_failures <= 1 THEN 3600000 WHEN card_failures = 2 THEN 21600000 ELSE 86400000 END END,
      card_failures = CASE WHEN NEW.status = 'completed' THEN 0 ELSE MAX(card_failures,1) END
    WHERE project_id = NEW.project_id AND session_id = CASE WHEN json_valid(NEW.run_context) THEN ${session} END; END`,
  `CREATE TRIGGER IF NOT EXISTS agent_run_login_retry AFTER UPDATE OF status ON agent_runs
    WHEN OLD.status IS NOT NEW.status AND NEW.status = 'failed' AND NEW.error_code = 'agent_not_signed_in'
      AND json_valid(NEW.run_context) BEGIN
    UPDATE learning_sessions SET card_failures = ${retry('cardFailures')}, card_retry_at = ${retry('cardRetryAt')}
      WHERE NEW.task = 'turn-cards' AND ${ownedRetry} AND project_id = NEW.project_id AND session_id = ${session}
        AND card_failures = ${retry('cardFailures')} + 1;
    UPDATE turn_cards SET due_at = (SELECT json_extract(value, '$.dueAt')
        FROM json_each(NEW.run_context, '$.${LEARNING_RETRY_KEY}.turns')
        WHERE json_extract(value, '$.turnKey') = turn_cards.turn_key AND json_extract(value, '$.changes') = turn_cards.changes)
      WHERE NEW.task = 'turn-cards' AND ${ownedRetry} AND project_id = NEW.project_id AND session_id = ${session} AND state = 'pending'
        AND EXISTS (SELECT 1 FROM json_each(NEW.run_context, '$.${LEARNING_RETRY_KEY}.turns')
          WHERE json_extract(value, '$.turnKey') = turn_cards.turn_key AND json_extract(value, '$.changes') = turn_cards.changes);
    UPDATE learning_sessions SET failures = ${retry('failures')}, eligible_at = ${retry('eligibleAt')}
      WHERE NEW.task = 'extract-curate' AND ${ownedRetry} AND project_id = NEW.project_id AND session_id = ${session}
        AND revision = ${retry('revision')} AND failures = ${retry('failures')} + 1 AND eligible_at IS NOT NULL;
    UPDATE sessions SET titling_attempts = MAX(0, titling_attempts - 1)
      WHERE NEW.task = 'title-summary' AND NEW.attempt_counted = 1 AND project_id = NEW.project_id AND session_id = ${session}
        AND NOT EXISTS (SELECT 1 FROM agent_runs p WHERE p.project_id = NEW.project_id
          AND p.id = json_extract(NEW.run_context, '$.replaces') AND p.attempt_counted = 1);
    UPDATE agent_runs SET attempt_counted = 0
      WHERE NEW.task = 'title-summary' AND NEW.attempt_counted = 1 AND project_id = NEW.project_id AND id = NEW.id;
    END`,
];

/** Why the step reaches tables earlier steps created. */
export const V694_REACHES: readonly Reach[] = reaching(['agent_runs'], 'The replacement terminal trigger excludes runner sign-in failures from card backoff. Card retries retain task backoff while runner sign-in failures release their claim reservation. A terminal sign-in failure returns only the retry reservation held by its dispatched attempt.');
