import { NEXT_SESSION_CURRENT } from './schema-vNEXT-session-current.js';
import { changing, retiring, type SchemaStep } from './schema-step.js';
import { titleBehindSql } from './sessions/title-coverage.js';

const key = (row: string) => `project_id=${row}.project_id AND session_id=${row}.session_id`;
const refresh = (row: string) => {
  const source = `FROM sessions s JOIN session_documents d ON d.project_id=s.project_id AND d.session_id=s.session_id
    WHERE s.project_id=${row}.project_id AND s.session_id=${row}.session_id AND ${titleBehindSql('s', 'd')}`;
  return `DELETE FROM session_title_work WHERE ${key(row)} AND mode='refresh' AND NOT EXISTS(SELECT 1 ${source});
    INSERT INTO session_title_work(project_id,session_id,mode,waits,due_at)
      SELECT s.project_id,s.session_id,'refresh',CASE WHEN s.ended_at IS NULL THEN 'quiet' ELSE 'timer' END,
        CASE WHEN s.ended_at IS NULL THEN s.last_received_at ELSE 0 END ${source}
      ON CONFLICT(project_id,session_id,mode) DO UPDATE SET ready=0,waits=excluded.waits,due_at=excluded.due_at,checks=0;`;
};
const replaced = ['sessions_title_work_state', 'session_documents_title_work_insert', 'session_documents_title_work_update'];
const wake = (row: string) => `UPDATE session_title_work SET ready=0,waits='timer',due_at=0,checks=0
  WHERE ${key(row)} AND mode='claim' AND waits='material';`;

/** Coverage is unknown for retained titles; only subsequent session activity admits their refresh. */
export const SESSION_CURRENT_STEPS: readonly SchemaStep[] = [{
  version: NEXT_SESSION_CURRENT,
  statements: [
    'ALTER TABLE sessions ADD COLUMN title_through_turn_key TEXT',
    'ALTER TABLE sessions ADD COLUMN title_attempt_turn_key TEXT',
    'ALTER TABLE sessions ADD COLUMN title_through_turn_revision INTEGER',
    'ALTER TABLE sessions ADD COLUMN title_attempt_turn_revision INTEGER',
    'ALTER TABLE session_documents ADD COLUMN title_through_turn_count INTEGER',
    'ALTER TABLE session_documents ADD COLUMN title_tracking INTEGER NOT NULL DEFAULT 0',
    ...replaced.map(name => `DROP TRIGGER IF EXISTS ${name}`),
    `CREATE TRIGGER IF NOT EXISTS sessions_title_work_state AFTER UPDATE OF title,ended_at,titled_at,titling_attempts,titling_requested_at,title_through_turn_key,title_through_turn_revision ON sessions BEGIN
      DELETE FROM session_title_work WHERE ${key('NEW')} AND mode='claim' AND NEW.title IS NOT NULL;
      INSERT INTO session_title_work(project_id,session_id,mode,waits,due_at)
        SELECT NEW.project_id,NEW.session_id,'claim',CASE WHEN NEW.ended_at IS NULL THEN 'quiet' ELSE 'timer' END,
          CASE WHEN NEW.ended_at IS NULL THEN NEW.last_received_at ELSE 0 END WHERE NEW.title IS NULL
          AND NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.project_id=NEW.project_id AND t.session_id=NEW.session_id)
        ON CONFLICT(project_id,session_id,mode) DO UPDATE SET ready=0,waits=excluded.waits,due_at=excluded.due_at,checks=0;
      ${refresh('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_documents_title_work_insert AFTER INSERT ON session_documents WHEN NEW.state='live' BEGIN
      ${wake('NEW')} ${refresh('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_documents_title_work_update AFTER UPDATE OF user_prompts,titled_user_prompts,state,open_turn_key,title_tracking ON session_documents BEGIN
      ${wake('NEW')} ${refresh('NEW')} END`,
    `CREATE TRIGGER IF NOT EXISTS session_title_tracking AFTER UPDATE OF last_received_at,ended_at ON sessions
      WHEN NEW.last_received_at IS NOT OLD.last_received_at OR NEW.ended_at IS NOT OLD.ended_at BEGIN
      UPDATE session_documents SET title_tracking=1 WHERE ${key('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS document_title_tracking AFTER UPDATE OF open_turn_key ON session_documents WHEN NEW.title_tracking=0 BEGIN
      UPDATE session_documents SET title_tracking=1 WHERE ${key('NEW')}; END`,
  ],
  retires: retiring('trigger', replaced, 'Title readiness follows recorded turn coverage.'),
  reaches: [
    ...changing(['sessions','session_documents'], 'Nullable coverage retains existing titles; tracking starts on the next activity.'),
  ],
}];
