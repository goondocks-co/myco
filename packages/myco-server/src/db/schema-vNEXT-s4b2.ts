import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const NEXT_S4B2 = 764;

/**
 * Per-session card contributions, deadline and ready relations, and the idle-close policy generation.
 *
 * A session's `pending_cards`, `due_cards` (carded and uncovered) and `signal_cards` move old to new from triggers on
 * `turn_cards`, one card at a time, for every writer: publication, settlement, model writes, completion, restore and
 * deletion. A session row is counted (`counted = 1`) once it holds its exact contribution: a new row counts its cards
 * when it is inserted, and existing rows through the shared catch-up, so a session not yet counted contributes nothing
 * to the per-Project rollup and a reader reports `building` rather than a zero.
 *
 * A session's card stage is due at `card_deadline`, the latest of its quiet instant, its retry clock and its earliest
 * model-due turn; its learning stage at `learning_deadline`. A pass promotes the sessions whose deadline has passed by
 * recording that deadline (`*_promoted_at`), and a later write moving the deadline takes the session out of the ready
 * set by itself. The ready relations are the partial indexes over `card_stage` and `learning_stage`, which also name
 * the stage's source-age bucket, so a head read seeks one stage and stops at its first session. `learning_ready_projects`
 * is the per-stage summary the pulled scheduler walks; it counts promoted rows only, so it is exact from the first pass
 * and needs no catch-up.
 *
 * Each large index stands alone in its own step.
 */
const CARD_DEADLINE = `CASE WHEN pending_cards>0 AND source_activity_at IS NOT NULL AND (counted=0 OR next_model_due_at IS NOT NULL) THEN MAX(quiet_at,card_retry_at,COALESCE(next_model_due_at,0)) END`;
const LEARNING_DEADLINE = 'CASE WHEN eligible_at IS NOT NULL AND source_activity_at IS NOT NULL THEN MAX(quiet_at,eligible_at) END';
const CARD_STAGE = `CASE WHEN card_deadline IS NOT NULL AND card_promoted_at=card_deadline THEN CASE WHEN aged=1 AND NOT (fresh_admitted=1 AND card_failures<4) THEN 'cardsHistory' ELSE 'cardsFresh' END END`;
const LEARNING_STAGE = `CASE WHEN learning_deadline IS NOT NULL AND learning_promoted_at=learning_deadline THEN CASE WHEN aged=1 AND NOT (fresh_admitted=1 AND failures<4) THEN 'learningHistory' ELSE 'learningFresh' END END`;

const SESSION_COLUMNS = ['counted', 'aged', 'pending_cards', 'due_cards', 'signal_cards', 'next_model_due_at', 'eligible_at', 'quiet_at', 'card_retry_at', 'card_failures', 'failures', 'fresh_admitted', 'init_state', 'card_promoted_at', 'learning_promoted_at', 'source_activity_at'];

/** What one counted session row adds to its Project's rollup, as SQL over the row alias `R`. */
const CONTRIBUTIONS: readonly (readonly [string, (R: string) => string])[] = [
  ['pending_cards', R => `${R}.pending_cards`],
  ['due_cards', R => `${R}.due_cards`],
  ['signal_cards', R => `${R}.signal_cards`],
  ['fresh_pending', R => `CASE WHEN ${R}.aged=1 AND NOT (${R}.fresh_admitted=1 AND ${R}.card_failures<4) THEN 0 ELSE ${R}.pending_cards END`],
  ['fresh_due', R => `CASE WHEN ${R}.aged=1 AND NOT (${R}.fresh_admitted=1 AND ${R}.failures<4) THEN 0 ELSE ${R}.due_cards END`],
  ['ready_sessions', R => `(${R}.learning_stage IS NOT NULL)`],
  ['fresh_ready_sessions', R => `(${R}.learning_stage IS 'learningFresh')`],
  ['history_waiting', R => `(${R}.aged=1 AND (${R}.pending_cards>0 OR ${R}.due_cards>0) AND NOT ((${R}.pending_cards>0 AND ${R}.fresh_admitted=1 AND ${R}.card_failures<4) OR (${R}.eligible_at IS NOT NULL AND ${R}.fresh_admitted=1 AND ${R}.failures<4)))`],
  ['awaiting_publication', R => `(${R}.init_state='awaiting_publication')`],
];
const COUNT_COLUMNS = CONTRIBUTIONS.map(([column]) => column);
const contribution = (R: 'NEW' | 'OLD', expression: string) => `${R}.counted*(${expression})`;
const delta = (expression: (R: string) => string) => `(${contribution('NEW', expression('NEW'))}-${contribution('OLD', expression('OLD'))})`;
const rollupSet = COUNT_COLUMNS.map(column => `${column}=${column}+excluded.${column}`).join(',');

const projectRollup = (values: readonly string[], project: string, where: string) =>
  `INSERT INTO learning_project_counts(project_id,${COUNT_COLUMNS.join(',')}) SELECT ${project},${values.join(',')} WHERE ${where}
    ON CONFLICT(project_id) DO UPDATE SET ${rollupSet}`;
const updateDeltas = CONTRIBUTIONS.map(([, expression]) => delta(expression));
const ROLLUP_MARK = "UPDATE change_marks SET revision=revision+1 WHERE kind='learning'";
const readyDelta = (stageColumn: 'card_stage' | 'learning_stage', row: 'NEW' | 'OLD', sign: 1 | -1) =>
  `INSERT INTO learning_ready_projects(stage,project_id,ready) SELECT ${row}.${stageColumn},${row}.project_id,${sign}
    WHERE ${row}.${stageColumn} IS NOT NULL AND OLD.${stageColumn} IS NOT NEW.${stageColumn}
    ON CONFLICT(stage,project_id) DO UPDATE SET ready=ready+excluded.ready`;

const MODEL_DUE = (row: 'NEW' | 'OLD') => `(SELECT MIN(c.due_at) FROM turn_cards c WHERE c.project_id=${row}.project_id AND c.session_id=${row}.session_id AND c.state='pending' AND c.due_at IS NOT NULL)`;
const SET_MODEL_DUE = (row: 'NEW' | 'OLD', when: string) => `UPDATE learning_sessions SET next_model_due_at=${MODEL_DUE(row)}
      WHERE project_id=${row}.project_id AND session_id=${row}.session_id AND ${when} AND next_model_due_at IS NOT ${MODEL_DUE(row)}`;
const signalled = (row: 'NEW' | 'OLD') => `(${row}.state='carded' AND IFNULL(${row}.signal,'none')<>'none')`;
const uncovered = (row: 'NEW' | 'OLD') => `(${row}.state='carded' AND ${row}.covered=0)`;
const sessionKey = (row: 'NEW' | 'OLD') => `project_id=${row}.project_id AND session_id=${row}.session_id`;
const lastCarded = (row: 'NEW') => `CASE WHEN ${row}.state='carded' AND ${row}.carded_at IS NOT NULL THEN MAX(COALESCE(last_carded_at,${row}.carded_at),${row}.carded_at) ELSE last_carded_at END`;
const recounted = `pending_cards=CASE WHEN EXISTS(SELECT 1 FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id) THEN (SELECT COUNT(*) FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.state='pending') ELSE pending_cards END,
      due_cards=CASE WHEN EXISTS(SELECT 1 FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id) THEN (SELECT COUNT(*) FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.state='carded' AND c.covered=0) ELSE due_cards END,
      signal_cards=CASE WHEN EXISTS(SELECT 1 FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id) THEN (SELECT COUNT(*) FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.state='carded' AND IFNULL(c.signal,'none')<>'none') ELSE signal_cards END,
      last_carded_at=(SELECT MAX(c.carded_at) FROM turn_cards c WHERE c.project_id=NEW.project_id AND c.session_id=NEW.session_id AND c.state='carded'),
      next_model_due_at=${MODEL_DUE('NEW')},
      counted=1`;

/** The scheduling and status indexes the deadline and ready relations and the Project rollup replace; none has a reader left. */
const RETIRED_INDEXES = ['idx_learning_cards_fresh', 'idx_learning_cards_ready', 'idx_learning_cards_retry', 'idx_learning_fresh', 'idx_learning_ready', 'idx_learning_retry',
  'idx_learning_source_pending', 'idx_learning_source_waiting', 'idx_learning_source_activity', 'idx_learning_eligible', 'idx_learning_eligible_all', 'idx_learning_init_pending',
  'idx_turn_cards_due', 'idx_turn_cards_due_all', 'idx_turn_cards_hash'];

export const VNEXT_S4B2_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S4B2, statements: [
    ...['signal_cards INTEGER NOT NULL DEFAULT 0', 'last_carded_at INTEGER', 'next_model_due_at INTEGER', 'counted INTEGER NOT NULL DEFAULT 0',
      'aged INTEGER NOT NULL DEFAULT 0', 'card_promoted_at INTEGER', 'learning_promoted_at INTEGER', 'quiet_generation INTEGER'].map(column => `ALTER TABLE learning_sessions ADD COLUMN ${column}`),
    `ALTER TABLE learning_sessions ADD COLUMN card_deadline INTEGER GENERATED ALWAYS AS (${CARD_DEADLINE}) VIRTUAL`,
    `ALTER TABLE learning_sessions ADD COLUMN learning_deadline INTEGER GENERATED ALWAYS AS (${LEARNING_DEADLINE}) VIRTUAL`,
    `ALTER TABLE learning_sessions ADD COLUMN card_stage TEXT GENERATED ALWAYS AS (${CARD_STAGE}) VIRTUAL`,
    `ALTER TABLE learning_sessions ADD COLUMN learning_stage TEXT GENERATED ALWAYS AS (${LEARNING_STAGE}) VIRTUAL`,
  ] },
  { version: NEXT_S4B2 + 1, statements: ['CREATE INDEX IF NOT EXISTS idx_learning_card_deadline ON learning_sessions(card_deadline DESC,project_id,session_id) WHERE card_deadline IS NOT NULL AND card_promoted_at IS NOT card_deadline'] },
  { version: NEXT_S4B2 + 2, statements: ['CREATE INDEX IF NOT EXISTS idx_learning_stage_deadline ON learning_sessions(learning_deadline DESC,project_id,session_id) WHERE learning_deadline IS NOT NULL AND learning_promoted_at IS NOT learning_deadline'] },
  { version: NEXT_S4B2 + 3, statements: ['CREATE INDEX IF NOT EXISTS idx_learning_card_ready ON learning_sessions(project_id,card_stage,source_activity_at DESC,session_id) WHERE card_stage IS NOT NULL'] },
  { version: NEXT_S4B2 + 4, statements: ['CREATE INDEX IF NOT EXISTS idx_learning_stage_ready ON learning_sessions(project_id,learning_stage,source_activity_at DESC,session_id) WHERE learning_stage IS NOT NULL'] },
  { version: NEXT_S4B2 + 5, statements: ['CREATE INDEX IF NOT EXISTS idx_learning_aging ON learning_sessions(source_activity_at) WHERE aged=0 AND source_activity_at IS NOT NULL'] },
  { version: NEXT_S4B2 + 6, statements: [
    `CREATE TABLE IF NOT EXISTS learning_project_counts(project_id TEXT NOT NULL PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}),${COUNT_COLUMNS.map(column => `${column} INTEGER NOT NULL DEFAULT 0`).join(',')}) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS learning_ready_projects(stage TEXT NOT NULL,project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),ready INTEGER NOT NULL,PRIMARY KEY(stage,project_id)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS learning_quiet_policy(id INTEGER PRIMARY KEY CHECK (id=1),generation INTEGER NOT NULL,minutes INTEGER NOT NULL,effective_minutes INTEGER,state TEXT NOT NULL CHECK (state IN ('building','active')),updated_at INTEGER NOT NULL)`,
    'DROP TRIGGER IF EXISTS turn_cards_pending_count',
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_insert_pending AFTER INSERT ON turn_cards WHEN NEW.state='pending' BEGIN
      UPDATE learning_sessions SET pending_cards=pending_cards+1 WHERE ${sessionKey('NEW')};
      ${SET_MODEL_DUE('NEW', 'NEW.due_at IS NOT NULL')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_insert_carded AFTER INSERT ON turn_cards WHEN NEW.state='carded' BEGIN
      UPDATE learning_sessions SET due_cards=due_cards+${uncovered('NEW')},signal_cards=signal_cards+${signalled('NEW')},last_carded_at=${lastCarded('NEW')} WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_carded AFTER UPDATE OF state ON turn_cards WHEN OLD.state='pending' AND NEW.state='carded' BEGIN
      UPDATE learning_sessions SET pending_cards=pending_cards-1,due_cards=due_cards+${uncovered('NEW')},signal_cards=signal_cards+${signalled('NEW')},last_carded_at=${lastCarded('NEW')},next_model_due_at=${MODEL_DUE('NEW')}
      WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_reset AFTER UPDATE OF state ON turn_cards WHEN OLD.state='carded' AND NEW.state='pending' BEGIN
      UPDATE learning_sessions SET pending_cards=pending_cards+1,due_cards=due_cards-${uncovered('OLD')},signal_cards=signal_cards-${signalled('OLD')},eligible_at=NULL,next_model_due_at=${MODEL_DUE('NEW')}
      WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_recarded AFTER UPDATE OF signal,carded_at ON turn_cards
      WHEN OLD.state='carded' AND NEW.state='carded' AND (OLD.signal IS NOT NEW.signal OR OLD.carded_at IS NOT NEW.carded_at) BEGIN
      UPDATE learning_sessions SET due_cards=due_cards+${uncovered('NEW')}-${uncovered('OLD')},signal_cards=signal_cards+${signalled('NEW')}-${signalled('OLD')},last_carded_at=${lastCarded('NEW')} WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_covered AFTER UPDATE OF covered ON turn_cards
      WHEN OLD.covered IS NOT NEW.covered AND OLD.state='carded' AND NEW.state='carded' AND OLD.signal IS NEW.signal AND OLD.carded_at IS NEW.carded_at BEGIN
      UPDATE learning_sessions SET due_cards=due_cards+${uncovered('NEW')}-${uncovered('OLD')} WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_due AFTER UPDATE OF due_at ON turn_cards
      WHEN OLD.due_at IS NOT NEW.due_at AND OLD.state='pending' AND NEW.state='pending' BEGIN
      ${SET_MODEL_DUE('NEW', 'true')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_delete_pending AFTER DELETE ON turn_cards WHEN OLD.state='pending' BEGIN
      UPDATE learning_sessions SET pending_cards=pending_cards-1 WHERE ${sessionKey('OLD')};
      ${SET_MODEL_DUE('OLD', 'OLD.due_at IS NOT NULL')}; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_cards_learning_delete_carded AFTER DELETE ON turn_cards WHEN OLD.state='carded' BEGIN
      UPDATE learning_sessions SET due_cards=due_cards-${uncovered('OLD')},signal_cards=signal_cards-${signalled('OLD')} WHERE ${sessionKey('OLD')}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_session_counted AFTER INSERT ON learning_sessions BEGIN
      UPDATE learning_sessions SET ${recounted} WHERE ${sessionKey('NEW')}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_counts_update AFTER UPDATE OF ${SESSION_COLUMNS.join(',')} ON learning_sessions
      WHEN ${updateDeltas.map(expression => `${expression}<>0`).join(' OR ')} BEGIN
      ${projectRollup(updateDeltas, 'NEW.project_id', 'true')};
      ${ROLLUP_MARK}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_counts_delete AFTER DELETE ON learning_sessions WHEN OLD.counted=1 BEGIN
      UPDATE learning_project_counts SET ${CONTRIBUTIONS.map(([column, expression]) => `${column}=${column}-(${contribution('OLD', expression('OLD'))})`).join(',')} WHERE project_id=OLD.project_id;
      ${ROLLUP_MARK}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_ready_project_update AFTER UPDATE OF ${SESSION_COLUMNS.join(',')} ON learning_sessions
      WHEN OLD.card_stage IS NOT NEW.card_stage OR OLD.learning_stage IS NOT NEW.learning_stage BEGIN
      ${readyDelta('card_stage', 'OLD', -1)}; ${readyDelta('card_stage', 'NEW', 1)};
      ${readyDelta('learning_stage', 'OLD', -1)}; ${readyDelta('learning_stage', 'NEW', 1)}; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_ready_project_delete AFTER DELETE ON learning_sessions WHEN OLD.card_stage IS NOT NULL OR OLD.learning_stage IS NOT NULL BEGIN
      UPDATE learning_ready_projects SET ready=ready-1 WHERE stage=OLD.card_stage AND project_id=OLD.project_id;
      UPDATE learning_ready_projects SET ready=ready-1 WHERE stage=OLD.learning_stage AND project_id=OLD.project_id; END`,
    `CREATE TRIGGER IF NOT EXISTS learning_source_refreshed AFTER UPDATE OF source_activity_at ON learning_sessions WHEN NEW.aged=1 AND NEW.source_activity_at IS NOT OLD.source_activity_at BEGIN
      UPDATE learning_sessions SET aged=0 WHERE project_id=NEW.project_id AND session_id=NEW.session_id; END`,
    "INSERT INTO change_marks(kind,revision) VALUES('learning',0) ON CONFLICT(kind) DO NOTHING",
    "INSERT INTO projection_catchup(projection,phase,done) SELECT 'learning_counts','learningCounts',NOT EXISTS(SELECT 1 FROM learning_sessions) ON CONFLICT DO NOTHING",
    "INSERT INTO projection_catchup(projection,phase,done) VALUES('learning_quiet_policy','learningQuietPolicy',1) ON CONFLICT DO NOTHING",
  ] },
  { version: NEXT_S4B2 + 7, statements: RETIRED_INDEXES.map(index => `DROP INDEX IF EXISTS ${index}`) },
];

export const LATEST_S4B2 = NEXT_S4B2 + VNEXT_S4B2_STEPS.length - 1;
