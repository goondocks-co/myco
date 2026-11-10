import { reaching, type SchemaStep, changing } from './schema-step.js';
/** Quiet deadlines retain an hour of fresh admission and the full idle wait for already historical receipts. */
const idleMinutes = `COALESCE((SELECT CASE WHEN json_valid(value) THEN CASE
  WHEN json_type(value) IN ('integer','real') AND json_extract(value,'$') = CAST(json_extract(value,'$') AS INTEGER)
    AND json_extract(value,'$') BETWEEN 5 AND 10080
  THEN json_extract(value,'$') END END FROM deployment_settings
  WHERE leaf = 'agent.titling_idle_close_minutes'),120)`;
const freshWindow = 86400000;
const admissionMargin = 3600000;
const quietAt = (session: string) => `CASE WHEN ${session}.ended_at IS NOT NULL THEN 0
  WHEN learning_sessions.source_activity_at + ${freshWindow} > ${session}.last_received_at
    THEN MIN(${session}.last_received_at + 60000 * ${idleMinutes}, learning_sessions.source_activity_at + ${freshWindow - admissionMargin})
  ELSE ${session}.last_received_at + 60000 * ${idleMinutes} END`;
const sessionQuietAt = `(SELECT ${quietAt('s')} FROM sessions s
  WHERE s.project_id = learning_sessions.project_id AND s.session_id = learning_sessions.session_id)`;
const setup = [
  'DROP TRIGGER IF EXISTS learning_session_quiet_insert',
  'DROP TRIGGER IF EXISTS sessions_learning_quiet',
  'DROP TRIGGER IF EXISTS learning_source_quiet',
  ...['insert', 'update', 'delete'].map(operation => `DROP TRIGGER IF EXISTS learning_quiet_setting_${operation}`),
  `CREATE TRIGGER IF NOT EXISTS learning_session_quiet_insert AFTER INSERT ON learning_sessions BEGIN
    UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt},0)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_learning_quiet AFTER UPDATE OF last_received_at,ended_at ON sessions
    WHEN NEW.last_received_at IS NOT OLD.last_received_at OR NEW.ended_at IS NOT OLD.ended_at BEGIN
    UPDATE learning_sessions SET quiet_at = ${quietAt('NEW')}
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  `CREATE TRIGGER IF NOT EXISTS learning_source_quiet AFTER UPDATE OF source_activity_at ON learning_sessions
    WHEN NEW.source_activity_at IS NOT OLD.source_activity_at BEGIN
    UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt},0)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map(operation => `CREATE TRIGGER IF NOT EXISTS learning_quiet_setting_${operation.toLowerCase()}
    AFTER ${operation === 'UPDATE' ? 'UPDATE OF value' : operation} ON deployment_settings
    WHEN ${operation === 'DELETE' ? 'OLD' : 'NEW'}.leaf = 'agent.titling_idle_close_minutes'${operation === 'UPDATE' ? ' AND NEW.value IS NOT OLD.value' : ''} BEGIN
    UPDATE learning_sessions SET quiet_at = ${sessionQuietAt} WHERE ${sessionQuietAt} IS NOT NULL; END`),
  'CREATE TABLE IF NOT EXISTS _learning_quiet_margin_range (high INTEGER NOT NULL)',
  'INSERT INTO _learning_quiet_margin_range SELECT COALESCE(MAX(rowid),0) FROM learning_sessions',
];
const PARTS = 32;
const backfill = Array.from({ length: PARTS }, (_, part) => [
  `UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt},0)
    WHERE rowid > ((SELECT high FROM _learning_quiet_margin_range)/${PARTS})*${part}${part === PARTS - 1 ? ''
      : ` AND rowid <= ((SELECT high FROM _learning_quiet_margin_range)/${PARTS})*${part + 1}`}`,
]);

const BACKFILL = 'Learning queue metadata backfills in disjoint rowid transactions while preserving cards and coverage.';
const QUEUES = 'Learning source activity, quiet eligibility and retry deadlines stay in indexed work queues.';

/** Each deadline backfill commits one disjoint rowid range. */
export const LEARNING_QUIET_MARGIN_STEPS: readonly SchemaStep[] = [
  { statements: setup, reaches: reaching(['learning_sessions', 'sessions', 'deployment_settings'], `${BACKFILL} ${QUEUES}`) },
  ...backfill.map((statements) => ({ statements, reaches: changing(['learning_sessions'], BACKFILL) })),
  { statements: ['DROP TABLE _learning_quiet_margin_range'] },
].map((step, index) => ({ version: 659 + index, ...step }));
