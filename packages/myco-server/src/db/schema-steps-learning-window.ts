import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';
import { MANUAL_LEARNING_INDEX_SQL } from './learning/manual.js';
import { settledLearningSql } from './learning/progress.js';
import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_LEARNING_WINDOW } from './schema-vNEXT-learning-window.js';
import { LEARNING_WINDOW_MS } from './runs/learning-policy.js';
import { LEARNING_COUNTS_RECONCILE_SQL } from './learning/counts.js';

const RETIRED_LEAF = 'agent.learning_history_enabled';
const TRIGGERS = ['learning_counts_update', 'learning_counts_delete', 'learning_ready_project_update', 'learning_ready_project_delete', 'learning_source_refreshed'];
const INDEXES = ['idx_learning_card_ready', 'idx_learning_stage_ready', 'idx_learning_card_deadline', 'idx_learning_stage_deadline', 'idx_learning_aging', 'idx_learning_card_waiting', 'idx_learning_stage_waiting'];
const RETIRED_COUNTS = ['fresh_pending', 'fresh_due', 'fresh_ready_sessions', 'history_waiting'];
const COLUMNS = ['counted', 'aged_out_at', 'pending_cards', 'due_cards', 'signal_cards', 'eligible_at', 'quiet_at', 'card_retry_at', 'init_state', 'card_promoted_at', 'learning_promoted_at', 'source_activity_at', 'next_model_due_at'];
const contributions: readonly (readonly [string, (r: string) => string])[] = [
  ['pending_cards', r => `CASE WHEN ${r}.aged_out_at IS NULL THEN ${r}.pending_cards ELSE 0 END`],
  ['due_cards', r => `CASE WHEN ${r}.aged_out_at IS NULL THEN ${r}.due_cards ELSE 0 END`],
  ['signal_cards', r => `${r}.signal_cards`],
  ['ready_sessions', r => `(${r}.learning_stage IS NOT NULL)`],
  ['aged_out_sessions', r => `(${r}.aged_out_at IS NOT NULL)`],
  ['awaiting_publication', r => `(${r}.aged_out_at IS NULL AND ${r}.init_state='awaiting_publication')`],
];
const contribution = (r: string, expression: (r: string) => string) => `${r}.counted*(${expression(r)})`;
const deltas = contributions.map(([, expression]) => `(${contribution('NEW', expression)}-${contribution('OLD', expression)})`);
const readyDelta = (column: string, row: string, sign: number) => `INSERT INTO learning_ready_projects(stage,project_id,ready)
  SELECT ${row}.${column},${row}.project_id,${sign} WHERE ${row}.${column} IS NOT NULL AND OLD.${column} IS NOT NEW.${column}
  ON CONFLICT(stage,project_id) DO UPDATE SET ready=ready+excluded.ready`;
const NOW = 'unixepoch()*1000';

/** The stored closure excludes unfinished sessions from automatic work while retaining their material for a named hand start. */
export const LEARNING_WINDOW_STEPS: readonly SchemaStep[] = [{
  version: NEXT_LEARNING_WINDOW,
  statements: [
    `INSERT OR IGNORE INTO retired_deployment_settings(leaf,value,updated_at,updated_by,retired_at)
      SELECT leaf,value,updated_at,updated_by,${NOW} FROM deployment_settings WHERE leaf='${RETIRED_LEAF}'`,
    `DROP TABLE IF EXISTS _learning_window_guard_settings`,
    `CREATE TABLE _learning_window_guard_settings(ok INTEGER NOT NULL CHECK(ok=1))`,
    `INSERT INTO _learning_window_guard_settings SELECT NOT EXISTS(SELECT 1 FROM deployment_settings live
      WHERE leaf='${RETIRED_LEAF}' AND NOT EXISTS(SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf=live.leaf
        AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by))`,
    'DROP TABLE _learning_window_guard_settings',
    `DELETE FROM deployment_settings WHERE leaf='${RETIRED_LEAF}'`,
    'ALTER TABLE learning_sessions ADD COLUMN aged_out_at INTEGER',
    `UPDATE learning_sessions SET aged_out_at=${NOW},eligible_at=NULL
      WHERE source_activity_at<=${NOW}-${LEARNING_WINDOW_MS} AND (pending_cards>0 OR due_cards>0 OR init_state<>'ready')`,
    'UPDATE learning_sessions SET counted=0,card_promoted_at=NULL,learning_promoted_at=NULL',
    ...TRIGGERS.map(name => `DROP TRIGGER IF EXISTS ${name}`),
    'DELETE FROM learning_project_counts',
    'DELETE FROM learning_ready_projects',
    ...INDEXES.map(name => `DROP INDEX IF EXISTS ${name}`),
    'ALTER TABLE learning_sessions DROP COLUMN card_stage',
    'ALTER TABLE learning_sessions DROP COLUMN learning_stage',
    'ALTER TABLE learning_sessions DROP COLUMN fresh_admitted',
    'ALTER TABLE learning_sessions DROP COLUMN aged',
    ...(['card', 'learning'] as const).map(kind => `ALTER TABLE learning_sessions ADD COLUMN ${kind}_stage TEXT GENERATED ALWAYS AS
      (CASE WHEN aged_out_at IS NULL AND ${kind}_deadline IS NOT NULL AND ${kind}_promoted_at=${kind}_deadline THEN '${kind === 'card' ? 'cards' : 'learning'}' END) VIRTUAL`),
    ...RETIRED_COUNTS.map(column => `ALTER TABLE learning_project_counts DROP COLUMN ${column}`),
    'ALTER TABLE learning_project_counts ADD COLUMN aged_out_sessions INTEGER NOT NULL DEFAULT 0',
    `CREATE TRIGGER IF NOT EXISTS learning_counts_update AFTER UPDATE OF ${COLUMNS.join(',')} ON learning_sessions
      WHEN ${deltas.map(delta => `${delta}<>0`).join(' OR ')} BEGIN
      INSERT INTO learning_project_counts(project_id,${contributions.map(([column]) => column).join(',')}) VALUES(NEW.project_id,${deltas.join(',')})
        ON CONFLICT(project_id) DO UPDATE SET ${contributions.map(([column]) => `${column}=${column}+excluded.${column}`).join(',')};
      UPDATE change_marks SET revision=revision+1 WHERE kind='learning'; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_counts_delete AFTER DELETE ON learning_sessions WHEN OLD.counted=1 BEGIN
      UPDATE learning_project_counts SET ${contributions.map(([column, expression]) => `${column}=${column}-(${contribution('OLD', expression)})`).join(',')} WHERE project_id=OLD.project_id;
      UPDATE change_marks SET revision=revision+1 WHERE kind='learning'; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_ready_project_update AFTER UPDATE OF ${COLUMNS.join(',')} ON learning_sessions
      WHEN OLD.card_stage IS NOT NEW.card_stage OR OLD.learning_stage IS NOT NEW.learning_stage BEGIN
      ${readyDelta('card_stage', 'OLD', -1)}; ${readyDelta('card_stage', 'NEW', 1)};
      ${readyDelta('learning_stage', 'OLD', -1)}; ${readyDelta('learning_stage', 'NEW', 1)}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_ready_project_delete AFTER DELETE ON learning_sessions WHEN OLD.card_stage IS NOT NULL OR OLD.learning_stage IS NOT NULL BEGIN
      UPDATE learning_ready_projects SET ready=ready-1 WHERE stage=OLD.card_stage AND project_id=OLD.project_id;
      UPDATE learning_ready_projects SET ready=ready-1 WHERE stage=OLD.learning_stage AND project_id=OLD.project_id; END`,
    ...(['card', 'learning'] as const).map(kind => `CREATE INDEX IF NOT EXISTS idx_learning_${kind === 'card' ? 'card' : 'stage'}_ready
      ON learning_sessions(project_id,${kind}_stage,source_activity_at DESC,session_id) WHERE ${kind}_stage IS NOT NULL`),
    ...(['card', 'learning'] as const).map(kind => `CREATE INDEX IF NOT EXISTS idx_learning_${kind === 'card' ? 'card' : 'stage'}_waiting ON learning_sessions(project_id,${kind}_stage,${kind}_promoted_at,session_id) WHERE ${kind}_stage IS NOT NULL`),
    ...(['card', 'learning'] as const).map(kind => `CREATE INDEX IF NOT EXISTS idx_learning_${kind === 'card' ? 'card' : 'stage'}_deadline
      ON learning_sessions(${kind}_deadline DESC,project_id,session_id) WHERE aged_out_at IS NULL AND ${kind}_deadline IS NOT NULL AND ${kind}_promoted_at IS NOT ${kind}_deadline`),
    `CREATE INDEX IF NOT EXISTS idx_learning_aging ON learning_sessions(source_activity_at) WHERE aged_out_at IS NULL AND source_activity_at IS NOT NULL AND (pending_cards>0 OR due_cards>0)`,
    `CREATE TRIGGER IF NOT EXISTS learning_source_refreshed AFTER UPDATE OF source_activity_at ON learning_sessions
      WHEN NEW.aged_out_at IS NOT NULL AND NEW.source_activity_at>OLD.source_activity_at BEGIN
      UPDATE learning_sessions SET aged_out_at=NULL WHERE project_id=NEW.project_id AND session_id=NEW.session_id;
      UPDATE learning_sessions SET ${settledLearningSql(NOW)} WHERE project_id=NEW.project_id AND session_id=NEW.session_id; END`,
    MANUAL_LEARNING_INDEX_SQL,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_learning_subject_live ON agent_runs(task,subject,status) WHERE ${IN_FLIGHT_RUN_STATUSES}`,
    LEARNING_COUNTS_RECONCILE_SQL,
  ],
  retires: [
    ...retiring('trigger', TRIGGERS.filter(name => name !== 'learning_source_refreshed'), 'Learning has one forward window and a stored terminal closure.'),
    ...retiring('index', INDEXES, 'Learning readiness excludes sessions closed by the window.'),
    ...retiring('column', ['fresh_admitted', 'aged'].map(column => `learning_sessions.${column}`), 'Source age no longer selects a separate learning path or extends retries.'),
    ...retiring('column', RETIRED_COUNTS.map(column => `learning_project_counts.${column}`), 'One learning path counts pending work and terminal closures.'),
  ],
  deploymentIndexes: [
    { index: 'idx_agent_runs_manual_learning', read: 'Card work seeks only live owner requests naming a session, within its Project when scoped.' },
    { index: 'idx_agent_runs_learning_subject_live', read: 'Learning checks one live subject without reading unrelated active runs.' },
  ],
  reaches: [
    ...changing(['deployment_settings', 'retired_deployment_settings', 'learning_sessions', 'learning_project_counts', 'learning_ready_projects'], 'Archive the retired switch, close unfinished history, and rebuild the existing contribution counters for one learning window.'),
    ...reaching(['agent_runs'], 'Index named owner requests and single-flight learning subjects.'),
  ],
}];
