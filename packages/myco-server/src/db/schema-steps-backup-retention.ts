import { changed, trigger } from './ddl.js';
import { retiring, type SchemaStep } from './schema-step.js';
import { LAST_S8B, NEXT_S8B } from './schema-vNEXT-s8b.js';
import { BACKUP_WEEK_HEADS_PHASE, BACKUP_WEEK_HEADS_PROJECTION } from './storage/backup-week-heads.js';

const WEEK_MS = 604_800_000;
const bumpGeneration = 'UPDATE backup_retention_state SET generation=generation+1 WHERE slot=1';

/** Replaces one week's head with that week's newest unpinned backup, read from the rows as they stand. */
const refreshWeek = (row: 'NEW' | 'OLD'): string[] => {
  const week = `${row}.created_at/${WEEK_MS}`;
  return [
    `DELETE FROM backup_week_heads WHERE week=${week}`,
    `INSERT INTO backup_week_heads(week,created_at,id)
      SELECT ${week},created_at,id FROM backups
       WHERE pinned=0 AND created_at>=(${week})*${WEEK_MS} AND created_at<((${week})+1)*${WEEK_MS}
       ORDER BY created_at DESC,id DESC LIMIT 1`,
  ];
};

const KEEP_SET_INPUTS = ['pinned', 'created_at', 'id', 'key', 'verification_state'] as const;

const INSERT_TRIGGER = trigger('backups_keep_set_insert', 'backups', 'INSERT', [bumpGeneration, ...refreshWeek('NEW')]);
const DELETE_TRIGGER = trigger('backups_keep_set_delete', 'backups', 'DELETE', [bumpGeneration, ...refreshWeek('OLD')]);
const UPDATE_TRIGGER = trigger('backups_keep_set_update', 'backups', `UPDATE OF ${KEEP_SET_INPUTS.join(',')}`,
  [bumpGeneration, ...refreshWeek('OLD'), ...refreshWeek('NEW')], changed(KEEP_SET_INPUTS));

/** The stated repair is the BREAK-GLASS.md section of this name. A refusal here precedes every change of the first step, so the version stays and a rerun applies the whole change. */
const DUPLICATE_KEY_AUDIT = `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM backups GROUP BY key HAVING COUNT(*)>1) THEN 1
  ELSE json_extract('[]','$[backups_duplicate_key:' || (SELECT key FROM backups GROUP BY key HAVING COUNT(*)>1 LIMIT 1) || ' see BREAK-GLASS.md section Duplicate backup key]') END`;

/**
 * Backup retention decides from week heads and a generation instead of re-reading every backup: a verification state on
 * each backup, the partial indexes the keep rule seeks, a unique object key behind a duplicate audit at the head
 * of the change, and the triggers that keep heads and generation in step with the rows.
 */
export const VNEXT_S8B_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S8B, statements: [
    DUPLICATE_KEY_AUDIT,
    "ALTER TABLE backups ADD COLUMN verification_state TEXT CHECK (verification_state IS NULL OR verification_state IN ('verified','failed'))",
    'ALTER TABLE backups ADD COLUMN verification_checked_at INTEGER',
    "ALTER TABLE backups ADD COLUMN verification_detail TEXT CHECK (verification_detail IS NULL OR verification_detail IN ('absent','size','sha256'))",
    'CREATE TABLE IF NOT EXISTS backup_week_heads(week INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, id TEXT NOT NULL) WITHOUT ROWID',
    'CREATE TABLE IF NOT EXISTS backup_retention_state(slot INTEGER PRIMARY KEY CHECK(slot=1), generation INTEGER NOT NULL DEFAULT 0, backlog INTEGER NOT NULL DEFAULT 0)',
    'INSERT INTO backup_retention_state(slot) VALUES(1) ON CONFLICT DO NOTHING',
  ] },
  { version: NEXT_S8B + 1, statements: ['CREATE INDEX IF NOT EXISTS idx_backups_unpinned ON backups(created_at,id) WHERE pinned=0'] },
  { version: NEXT_S8B + 2, statements: ["CREATE INDEX IF NOT EXISTS idx_backups_verified ON backups(created_at,id) WHERE verification_state='verified'"] },
  { version: NEXT_S8B + 3, statements: [
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_backups_key_unique ON backups(key)',
    'DROP INDEX IF EXISTS idx_backups_key',
  ], retires: retiring('index', ['idx_backups_key'], 'The unique index on the same key replaces it, and object settlement seeks a backup through that one.') },
  { version: LAST_S8B, statements: [
    INSERT_TRIGGER.sql, DELETE_TRIGGER.sql, UPDATE_TRIGGER.sql,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${BACKUP_WEEK_HEADS_PROJECTION}','${BACKUP_WEEK_HEADS_PHASE}',NOT EXISTS(SELECT 1 FROM backups) ON CONFLICT DO NOTHING`,
  ] },
];
