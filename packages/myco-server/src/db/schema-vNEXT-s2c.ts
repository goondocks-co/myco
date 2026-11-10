import { retiring, type SchemaStep, reaching, changing } from './schema-step.js';
import { changed, trigger } from './ddl.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S2C = 747;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S2C = NEXT_S2C + 4;

/** The new user prompts past the standing title's record that make a titled session worth a refresh; `TITLING_REFRESH_MIN_PROMPTS` as of this step. */
const REFRESH_PROMPTS = 10;

const CLAIM = (row: string) => `project_id=${row}.project_id AND session_id=${row}.session_id AND mode='claim'`;
const REFRESH = (row: string) => `project_id=${row}.project_id AND session_id=${row}.session_id AND mode='refresh'`;
const NOT_TOMBSTONED = (row: string) => `NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=${row}.project_id AND t.session_id=${row}.session_id)`;

/** The claim row a session's own columns imply: an open session waits until it goes quiet; any other is looked at now. The promotion decides the rest. */
const claimUpsert = (row: string) => `INSERT INTO session_title_work(project_id,session_id,mode,waits,due_at)
  SELECT ${row}.project_id,${row}.session_id,'claim',CASE WHEN ${row}.ended_at IS NULL THEN 'quiet' ELSE 'timer' END,CASE WHEN ${row}.ended_at IS NULL THEN ${row}.last_received_at ELSE 0 END
  WHERE ${row}.title IS NULL AND ${NOT_TOMBSTONED(row)}
  ON CONFLICT(project_id,session_id,mode) DO UPDATE SET ready=0,waits=excluded.waits,due_at=excluded.due_at,checks=0`;

/** A titled session with enough prompts past its standing title's record, by the session's and live document's own columns. */
const REFRESH_OWED = `s.title IS NOT NULL AND s.titled_at IS NOT NULL AND d.state='live' AND d.user_prompts-COALESCE(d.titled_user_prompts,0)>=${REFRESH_PROMPTS}`;
const refreshSource = (row: string) => `FROM sessions s JOIN session_documents d ON d.project_id=s.project_id AND d.session_id=s.session_id
  WHERE s.project_id=${row}.project_id AND s.session_id=${row}.session_id AND ${REFRESH_OWED}`;

/** A key's refresh row re-derived: present while the session owes a refresh, looked at on the next pass, removed when it no longer does. */
const refreshReconcile = (row: string) => [
  `DELETE FROM session_title_work WHERE ${REFRESH(row)} AND NOT EXISTS (SELECT 1 ${refreshSource(row)})`,
  `INSERT INTO session_title_work(project_id,session_id,mode,waits,due_at)
    SELECT s.project_id,s.session_id,'refresh','timer',0 ${refreshSource(row)} AND ${NOT_TOMBSTONED('s')}
    ON CONFLICT(project_id,session_id,mode) DO UPDATE SET ready=0,waits='timer',due_at=0,checks=0`,
];

/** A session whose document gained its first user prompts: a claim parked for want of material is looked at again. */
const wakeForMaterial = (row: string) => `UPDATE session_title_work SET ready=0,waits='timer',due_at=0,checks=0 WHERE ${CLAIM(row)} AND waits='material'`;

const cohortBump = (row: string, delta: 1 | -1, only = '1') => `INSERT INTO session_title_work_counts(cohort,n) SELECT ${row}.cohort,${delta} WHERE ${only}
  ON CONFLICT(cohort) DO UPDATE SET n=n${delta === 1 ? '+1' : '-1'}`;

/** The columns of `sessions` that decide what title work a session has; the last receipt is watched on its own. */
const STATE_COLUMNS = ['title', 'ended_at', 'titled_at', 'titling_attempts', 'titling_requested_at'] as const;
const DELTA = (row: string) => `${row}.user_prompts-COALESCE(${row}.titled_user_prompts,0)>=${REFRESH_PROMPTS}`;

const TITLE_WORK_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS session_title_work(
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('claim','refresh')),
    ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1)),
    waits TEXT NOT NULL DEFAULT 'timer' CHECK (waits IN ('timer','quiet','material')),
    due_at INTEGER NOT NULL DEFAULT 0,rank_at INTEGER NOT NULL DEFAULT 0,
    cohort TEXT NOT NULL DEFAULT 'live' CHECK (cohort IN ('live','imported','requested')),
    checks INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(project_id,session_id,mode)) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS session_title_work_counts(cohort TEXT PRIMARY KEY,n INTEGER NOT NULL) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_session_title_work_due ON session_title_work(waits,due_at,project_id,session_id,mode) WHERE ready=0`,
  `CREATE INDEX IF NOT EXISTS idx_session_title_work_ready ON session_title_work(mode,cohort,rank_at DESC,project_id,session_id) WHERE ready=1`,
  trigger('session_title_work_count_insert', 'session_title_work', 'INSERT', cohortBump('NEW', 1), "NEW.mode='claim' AND NEW.ready=1").sql,
  trigger('session_title_work_count_delete', 'session_title_work', 'DELETE', cohortBump('OLD', -1), "OLD.mode='claim' AND OLD.ready=1").sql,
  trigger('session_title_work_count_update', 'session_title_work', 'UPDATE OF ready,cohort', [
    cohortBump('OLD', -1, 'OLD.ready=1'),
    cohortBump('NEW', 1, 'NEW.ready=1'),
  ], "NEW.mode='claim' AND (OLD.ready IS NOT NEW.ready OR OLD.cohort IS NOT NEW.cohort)").sql,
  trigger('sessions_title_work_insert', 'sessions', 'INSERT', claimUpsert('NEW')).sql,
  trigger('sessions_title_work_state', 'sessions', `UPDATE OF ${STATE_COLUMNS.join(',')}`, [
    `DELETE FROM session_title_work WHERE ${CLAIM('NEW')} AND NEW.title IS NOT NULL`,
    claimUpsert('NEW'),
    ...refreshReconcile('NEW'),
  ], changed(STATE_COLUMNS)).sql,
  trigger('sessions_title_work_activity', 'sessions', 'UPDATE OF last_received_at', [
    `UPDATE session_title_work SET ready=0,waits=CASE WHEN NEW.ended_at IS NULL THEN 'quiet' ELSE 'timer' END,due_at=CASE WHEN NEW.ended_at IS NULL THEN NEW.last_received_at ELSE 0 END,checks=0
      WHERE ${CLAIM('NEW')} AND NEW.title IS NULL AND (NEW.ended_at IS NULL OR (NEW.titled_at IS NULL AND NEW.titling_requested_at IS NOT NULL))`,
    `UPDATE session_title_work SET rank_at=NEW.last_received_at WHERE ${REFRESH('NEW')} AND ready=1 AND NEW.title IS NOT NULL`,
  ], 'NEW.last_received_at IS NOT OLD.last_received_at').sql,
  trigger('sessions_title_work_delete', 'sessions', 'DELETE', `DELETE FROM session_title_work WHERE project_id=OLD.project_id AND session_id=OLD.session_id`).sql,
  trigger('session_tombstones_title_work', 'session_tombstones', 'INSERT', `DELETE FROM session_title_work WHERE project_id=NEW.project_id AND session_id=NEW.session_id`).sql,
  trigger('session_documents_title_work_insert', 'session_documents', 'INSERT', [wakeForMaterial('NEW'), ...refreshReconcile('NEW')], "NEW.state='live' AND NEW.user_prompts>0").sql,
  trigger('session_documents_title_work_update', 'session_documents', 'UPDATE OF user_prompts,titled_user_prompts,state', [wakeForMaterial('NEW'), ...refreshReconcile('NEW')],
    `OLD.state IS NOT NEW.state OR (${DELTA('OLD')}) IS NOT (${DELTA('NEW')}) OR (OLD.user_prompts=0 AND NEW.user_prompts>0)`).sql,
  trigger('transcripts_title_work_insert', 'transcripts', 'INSERT', `UPDATE session_title_work SET ready=0,waits='timer',due_at=0,checks=0 WHERE ${CLAIM('NEW')} AND ready=1`).sql,
  trigger('transcripts_title_work_imported', 'transcripts', 'UPDATE OF imported_at', `UPDATE session_title_work SET ready=0,waits='timer',due_at=0,checks=0 WHERE ${CLAIM('NEW')} AND ready=1`, 'OLD.imported_at IS NOT NEW.imported_at').sql,
  `INSERT INTO projection_catchup(projection,phase,done) SELECT 'session_title_work','titleWork',NOT EXISTS(SELECT 1 FROM sessions) ON CONFLICT DO NOTHING`,
];

/** Title work is one keyed row per session and mode, and the four scans it replaces go in steps of their own, once their readers have moved. */
export const VNEXT_S2C_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S2C, statements: TITLE_WORK_STATEMENTS, reaches: [
    ...reaching(['sessions', 'session_tombstones', 'session_documents', 'transcripts'], 'A session\'s own columns, its live document and its transcripts move its one title work row, so a pass reads due and ready rows instead of scanning sessions.'),
    ...changing(['projection_catchup'], 'Title work is seeded through the shared catch-up, and the four titling scan indexes go once their readers read title work.'),
  ],
    deploymentIndexes: [
      { index: 'idx_session_title_work_due', read: 'the titling promotion seeks the sleeping rows due across the Deployment, by what they wait for and their deadline' },
      { index: 'idx_session_title_work_ready', read: 'a titling pass takes the ready rows across the Deployment, by mode, cohort and recency' },
    ],
  },
  { version: NEXT_S2C + 1, statements: ['DROP INDEX IF EXISTS idx_sessions_pending_title'], retires: retiring('index', ['idx_sessions_pending_title'], 'Title work\'s own indexes take the place of this titling scan index once its readers read title work.') },
  { version: NEXT_S2C + 2, statements: ['DROP INDEX IF EXISTS idx_sessions_untitled_ended'], retires: retiring('index', ['idx_sessions_untitled_ended'], 'Title work\'s own indexes take the place of this titling scan index once its readers read title work.') },
  { version: NEXT_S2C + 3, statements: ['DROP INDEX IF EXISTS idx_sessions_untitled_open'], retires: retiring('index', ['idx_sessions_untitled_open'], 'Title work\'s own indexes take the place of this titling scan index once its readers read title work.') },
  { version: LAST_S2C, statements: ['DROP INDEX IF EXISTS idx_sessions_titled_recent'], retires: retiring('index', ['idx_sessions_titled_recent'], 'Title work\'s own indexes take the place of this titling scan index once its readers read title work.') },
];
