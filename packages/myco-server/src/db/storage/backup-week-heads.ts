import type { CatchupFamily } from '../projections/family.js';
import { write } from '../index.js';

export const BACKUP_WEEK_HEADS_PROJECTION = 'backup_week_heads';
export const BACKUP_WEEK_HEADS_PHASE = 'backupWeekHeads';

const WEEK_MS = 604_800_000;
const PAGE_WEEKS = `SELECT DISTINCT CAST(json_extract(value,'$[0]') AS INTEGER)/${WEEK_MS} AS week FROM json_each(?1)`;
const inWeek = (week: string) => `pinned=0 AND created_at>=${week}*${WEEK_MS} AND created_at<(${week}+1)*${WEEK_MS}`;

const reconcileHeads = write<[keys: string]>({ name: 'storage.reconcileBackupWeekHeads', sql:
  `INSERT INTO backup_week_heads(week,created_at,id)
    SELECT w.week,(SELECT created_at FROM backups WHERE ${inWeek('w.week')} ORDER BY created_at DESC,id DESC LIMIT 1),
      (SELECT id FROM backups WHERE ${inWeek('w.week')} ORDER BY created_at DESC,id DESC LIMIT 1)
    FROM (${PAGE_WEEKS}) w WHERE EXISTS(SELECT 1 FROM backups WHERE ${inWeek('w.week')})
    ON CONFLICT(week) DO UPDATE SET created_at=excluded.created_at,id=excluded.id` });
const clearEmptyWeeks = write<[keys: string]>({ name: 'storage.clearEmptyBackupWeeks', sql:
  `DELETE FROM backup_week_heads WHERE week IN (${PAGE_WEEKS.replace('SELECT DISTINCT', 'SELECT')})
    AND NOT EXISTS(SELECT 1 FROM backups WHERE ${inWeek('backup_week_heads.week')})` });
const clearHeads = write<[]>({ name: 'storage.clearBackupWeekHeads', sql: 'DELETE FROM backup_week_heads' });

/**
 * Week heads for backups published before the heads existed. A page reads the weeks its keys fall in and replaces those
 * heads from the rows as they stand, the same seek the triggers run; a backup written during the build rewrites its own
 * week, so a head never rests on a row a page saw earlier.
 */
export const BACKUP_WEEK_HEADS_CATCHUP = {
  projection: BACKUP_WEEK_HEADS_PROJECTION,
  reset: () => [clearHeads.bind()],
  phases: { [BACKUP_WEEK_HEADS_PHASE]: {
    source: { table: 'backups', columns: ['created_at', 'id'], unique: true, startKey: [-1, ''] },
    reconcile: [reconcileHeads, clearEmptyWeeks],
  } },
} as const satisfies CatchupFamily;
