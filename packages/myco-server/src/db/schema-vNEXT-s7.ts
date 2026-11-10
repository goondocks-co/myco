import { retiring, type SchemaStep } from './schema-step.js';

/** Placeholder first step of this change; the coordinator assigns the real number at merge. */
export const NEXT_S7 = 781;

const LEAF = 'agent.titling_idle_close_minutes';
/** Quiet deadlines retain an hour of fresh admission and the full idle wait for receipts already historical. */
const FRESH_WINDOW_MS = 86_400_000;
const ADMISSION_MARGIN_MS = 3_600_000;

/** The stored leaf's minutes, or the default. The policy row is seeded from it and a restored store may predate that row. */
const LEAF_MINUTES = `COALESCE((SELECT CASE WHEN json_valid(value) THEN CASE
  WHEN json_type(value) IN ('integer','real') AND json_extract(value,'$') = CAST(json_extract(value,'$') AS INTEGER)
    AND json_extract(value,'$') BETWEEN 5 AND 10080
  THEN json_extract(value,'$') END END FROM deployment_settings WHERE leaf = '${LEAF}'),120)`;

/** The minutes a new row runs on: the generation being built, which stamps the row so the walk has nothing to do for it. */
const PENDING_MINUTES = `COALESCE((SELECT minutes FROM learning_quiet_policy WHERE id=1),${LEAF_MINUTES})`;
/** The minutes an existing row runs on: the pending value once the walk has reached it, and the effective one before that. */
const ROW_MINUTES = `COALESCE((SELECT CASE WHEN learning_sessions.quiet_generation IS generation THEN minutes ELSE COALESCE(effective_minutes,minutes) END
  FROM learning_quiet_policy WHERE id=1),${LEAF_MINUTES})`;

const quietAt = (session: string, minutes: string) => `CASE WHEN ${session}.ended_at IS NOT NULL THEN 0
  WHEN learning_sessions.source_activity_at + ${FRESH_WINDOW_MS} > ${session}.last_received_at
    THEN MIN(${session}.last_received_at + 60000 * ${minutes}, learning_sessions.source_activity_at + ${FRESH_WINDOW_MS - ADMISSION_MARGIN_MS})
  ELSE ${session}.last_received_at + 60000 * ${minutes} END`;
const sessionQuietAt = (minutes: string) => `(SELECT ${quietAt('s', minutes)} FROM sessions s
  WHERE s.project_id = learning_sessions.project_id AND s.session_id = learning_sessions.session_id)`;

/**
 * A changed idle close no longer rewrites every session in the settings write. The settings commit records a generation,
 * the shared catch-up rewrites deadlines in keyed pages, and the generation activates when the walk completes. A row
 * follows the generation it has reached, so activity during a walk neither reverts a visited session nor moves an
 * unvisited one ahead of it.
 */
export const VNEXT_S7_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S7, statements: [
    `INSERT INTO learning_quiet_policy(id,generation,minutes,effective_minutes,state,updated_at)
      SELECT 1,COALESCE((SELECT revision FROM setting_revisions WHERE scope='' AND leaf='${LEAF}'),0),${LEAF_MINUTES},${LEAF_MINUTES},'active',0
      WHERE true ON CONFLICT(id) DO NOTHING`,
    ...['insert', 'update', 'delete'].map(operation => `DROP TRIGGER IF EXISTS learning_quiet_setting_${operation}`),
    'DROP TRIGGER IF EXISTS learning_session_quiet_insert',
    'DROP TRIGGER IF EXISTS sessions_learning_quiet',
    'DROP TRIGGER IF EXISTS learning_source_quiet',
    `CREATE TRIGGER IF NOT EXISTS learning_session_quiet_insert AFTER INSERT ON learning_sessions BEGIN
      UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt(PENDING_MINUTES)},0),
        quiet_generation = (SELECT generation FROM learning_quiet_policy WHERE id=1)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
    `CREATE TRIGGER IF NOT EXISTS sessions_learning_quiet AFTER UPDATE OF last_received_at,ended_at ON sessions
      WHEN NEW.last_received_at IS NOT OLD.last_received_at OR NEW.ended_at IS NOT OLD.ended_at BEGIN
      UPDATE learning_sessions SET quiet_at = ${quietAt('NEW', ROW_MINUTES)}
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_source_quiet AFTER UPDATE OF source_activity_at ON learning_sessions
      WHEN NEW.source_activity_at IS NOT OLD.source_activity_at BEGIN
      UPDATE learning_sessions SET quiet_at = COALESCE(${sessionQuietAt(ROW_MINUTES)},0)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  ], retires: [
    ...retiring('trigger', ['insert', 'update', 'delete'].map(operation => `learning_quiet_setting_${operation}`),
      'A changed idle close records a policy generation in the settings commit, and the catch-up rewrites session deadlines in keyed pages instead of this trigger rewriting every session in the write.'),
    ...retiring('trigger', ['learning_session_quiet_insert', 'sessions_learning_quiet', 'learning_source_quiet'],
      'The per-session deadline triggers are rebuilt to follow the policy generation a session has reached, instead of reading the stored setting directly.'),
  ] },
];
