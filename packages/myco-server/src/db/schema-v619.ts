/** Receipt-time quietness and retry deadlines form the indexed learning work queues. */
const idleMinutes = `COALESCE((SELECT CASE WHEN json_valid(value) THEN CASE
  WHEN json_type(value) IN ('integer','real') AND json_extract(value,'$') = CAST(json_extract(value,'$') AS INTEGER)
    AND json_extract(value,'$') BETWEEN 5 AND 10080
  THEN json_extract(value,'$') END END FROM deployment_settings
  WHERE leaf = 'agent.titling_idle_close_minutes'),120)`;
const quietAt = (session: string) => `CASE WHEN ${session}.ended_at IS NOT NULL THEN 0
  ELSE ${session}.last_received_at + 60000 * ${idleMinutes} END`;
const sessionQuietAt = `(SELECT ${quietAt('s')} FROM sessions s
  WHERE s.project_id = learning_sessions.project_id AND s.session_id = learning_sessions.session_id)`;

const setup = [
  'ALTER TABLE learning_sessions ADD COLUMN source_day INTEGER GENERATED ALWAYS AS (CAST(source_activity_at / 86400000 AS INTEGER)) VIRTUAL',
  'ALTER TABLE learning_sessions ADD COLUMN quiet_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE learning_sessions ADD COLUMN card_failures INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE learning_sessions ADD COLUMN card_retry_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE learning_sessions ADD COLUMN card_ready_at INTEGER GENERATED ALWAYS AS (MAX(quiet_at,card_retry_at)) VIRTUAL',
  'ALTER TABLE learning_sessions ADD COLUMN learning_ready_at INTEGER GENERATED ALWAYS AS (MAX(quiet_at,COALESCE(eligible_at,0))) VIRTUAL',
  `CREATE TRIGGER IF NOT EXISTS learning_session_quiet_insert AFTER INSERT ON learning_sessions BEGIN
    UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt},0)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_learning_quiet AFTER UPDATE OF last_received_at,ended_at ON sessions
    WHEN NEW.last_received_at IS NOT OLD.last_received_at OR NEW.ended_at IS NOT OLD.ended_at BEGIN
    UPDATE learning_sessions SET quiet_at = ${quietAt('NEW')}
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  ...(['INSERT','UPDATE','DELETE'] as const).map(operation => `CREATE TRIGGER IF NOT EXISTS learning_quiet_setting_${operation.toLowerCase()}
    AFTER ${operation === 'UPDATE' ? 'UPDATE OF value' : operation} ON deployment_settings
    WHEN ${operation === 'DELETE' ? 'OLD' : 'NEW'}.leaf = 'agent.titling_idle_close_minutes' BEGIN
    UPDATE learning_sessions SET quiet_at = ${sessionQuietAt} WHERE ${sessionQuietAt} IS NOT NULL; END`),
  `CREATE TRIGGER IF NOT EXISTS card_run_retry AFTER UPDATE OF status ON agent_runs
    WHEN NEW.task = 'turn-cards' AND OLD.status IS NOT NEW.status AND NEW.status IN ('completed','failed') BEGIN
    UPDATE learning_sessions SET
      card_retry_at = CASE WHEN NEW.status = 'completed' THEN 0 ELSE COALESCE(NEW.completed_at,NEW.started_at) +
        CASE WHEN card_failures <= 1 THEN 3600000 WHEN card_failures = 2 THEN 21600000 ELSE 86400000 END END,
      card_failures = CASE WHEN NEW.status = 'completed' THEN 0 ELSE MAX(card_failures,1) END
    WHERE project_id = NEW.project_id AND session_id = CASE WHEN json_valid(NEW.run_context) THEN json_extract(NEW.run_context,'$.session_id') END; END`,
  'CREATE TABLE IF NOT EXISTS _learning_quiet_range (high INTEGER NOT NULL)',
  'INSERT INTO _learning_quiet_range SELECT COALESCE(MAX(rowid),0) FROM learning_sessions',
];

const PARTS = 32;
const backfill = Array.from({ length: PARTS }, (_, part) => [
  `UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt},0)
    WHERE rowid > ((SELECT high FROM _learning_quiet_range)/${PARTS})*${part}${part === PARTS - 1 ? ''
      : ` AND rowid <= ((SELECT high FROM _learning_quiet_range)/${PARTS})*${part + 1}`}`,
]);
const indexes = [
  `CREATE INDEX IF NOT EXISTS idx_learning_cards_ready ON learning_sessions (project_id,card_ready_at,source_activity_at DESC,session_id)
    WHERE pending_cards > 0`,
  `CREATE INDEX IF NOT EXISTS idx_learning_ready ON learning_sessions (project_id,learning_ready_at,source_activity_at DESC,session_id)
    WHERE eligible_at IS NOT NULL`,
].map(sql => [sql]);

const freshIndexes = [
  `CREATE INDEX IF NOT EXISTS idx_learning_cards_fresh ON learning_sessions (project_id,source_day,card_ready_at,source_activity_at DESC,session_id)
    WHERE pending_cards > 0`,
  `CREATE INDEX IF NOT EXISTS idx_learning_fresh ON learning_sessions (project_id,source_day,learning_ready_at,source_activity_at DESC,session_id)
    WHERE eligible_at IS NOT NULL`,
].map(sql => [sql]);

/** Disjoint rowid transactions populate receipt deadlines without rewriting session bodies or cards. */
export const LEARNING_QUIET_STEPS = [setup, ...backfill, ...indexes, ['DROP TABLE _learning_quiet_range'], ...freshIndexes]
  .map((statements, index) => ({ version: 619 + index, statements }));
