import { objectJournalSql } from './object-journal.js';
import { HOLD_OPEN } from './release-queue.js';
import { BACKUP_WEEK_HEADS_PHASE, BACKUP_WEEK_HEADS_PROJECTION } from './backup-week-heads.js';
import { RESTORE_HOLD_PHASE } from './restore-hold.js';
import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, commitNamed, read, readSet, refusalCode, write, type Bound } from '../index.js';

/** One retention decision holds at most this many backups. */
export const RETENTION_PAGE = 16;
export const BACKUP_RETENTION_CHANGED = refusalCode('backup_retention_changed');

const headsDone = `COALESCE((SELECT done FROM projection_catchup WHERE projection='${BACKUP_WEEK_HEADS_PROJECTION}' AND phase='${BACKUP_WEEK_HEADS_PHASE}'),0)`;

/**
 * What the rule keeps, from the rows as they stand: the newest `daily` unpinned backups, the head of each of the `weekly`
 * most recent occupied weeks, and the newest verified backup. Pinned backups are never selected and consume no slot.
 */
const keepSet = (daily: string, weekly: string) =>
  `SELECT id FROM (SELECT id FROM backups WHERE pinned=0 ORDER BY created_at DESC,id DESC LIMIT ${daily})
    UNION SELECT id FROM (SELECT id FROM backup_week_heads ORDER BY week DESC LIMIT ${weekly})
    UNION SELECT id FROM (SELECT id FROM backups WHERE verification_state='verified' ORDER BY created_at DESC,id DESC LIMIT 1)`;
const inUseByRestore = `SELECT artifact_hash FROM backup_restore_progress WHERE NOT (table_name GLOB '${RESTORE_HOLD_PHASE}:*' AND next_row=1)`;
const notInRestore = (alias: string) => `(${alias}.sha256 IS NULL OR ${alias}.sha256 NOT IN (${inUseByRestore}))`;
const releasable = (alias: string, daily: string, weekly: string) =>
  `${alias}.pinned=0 AND ${alias}.id NOT IN (${keepSet(daily, weekly)}) AND ${notInRestore(alias)}`;

interface RetentionState { generation: number; backlog: number; ready: number }
const state = read<[], RetentionState>({ name: 'storage.backupRetentionState', sql:
  `SELECT generation,backlog,${headsDone} AS ready FROM backup_retention_state WHERE slot=1` });
const victimsPage = read<[daily: number, weekly: number, limit: number], { id: string }>({ name: 'storage.backupRetentionVictims', sql:
  `SELECT bk.id FROM backups bk WHERE ${releasable('bk', '?1', '?2')} ORDER BY bk.created_at,bk.id LIMIT ?3` });
const keepSetHeld = assertion<[generation: number]>({ name: 'storage.backupKeepSetHeld',
  when: `(SELECT generation FROM backup_retention_state WHERE slot=1)=?1 AND ${headsDone}=1`,
  refusal: BACKUP_RETENTION_CHANGED });

const recordCandidates = write<[at: number, ids: string]>({ name: 'storage.backupCandidates', sql:
  `INSERT INTO backup_release_candidates(id,created_at) SELECT value,?1 FROM json_each(?2) WHERE value IS NOT NULL
    ON CONFLICT(id) DO NOTHING` });
const journal = write<[at: number, ids: string, daily: number, weekly: number], { physical: string }>({ name: 'storage.releaseBackupObjects', sql:
  objectJournalSql(`SELECT bk.key,'backup',?1 FROM backups bk
    WHERE bk.id IN (SELECT value FROM json_each(?2)) AND ?3>=1 AND NOT ${HOLD_OPEN}
      AND ${releasable('bk', '?3', '?4')}
      AND EXISTS(SELECT 1 FROM backup_release_candidates rc WHERE rc.id=bk.id)`) + ' RETURNING physical' });
const removeRows = write<[ids: string], { id: string }>({ name: 'storage.removeReleasedBackups', sql:
  `DELETE FROM backups WHERE id IN (SELECT value FROM json_each(?1)) AND pinned=0 AND NOT ${HOLD_OPEN}
    AND EXISTS(SELECT 1 FROM object_releases r WHERE r.physical=backups.key) RETURNING id` });
const clearCandidates = write<[ids: string]>({ name: 'storage.clearBackupCandidates', sql:
  `DELETE FROM backup_release_candidates WHERE id IN (SELECT value FROM json_each(?1)) AND NOT ${HOLD_OPEN}` });
const stillHeld = read<[ids: string], { held: number }>({ name: 'storage.heldBackupCandidates', sql:
  'SELECT COUNT(*) AS held FROM backup_release_candidates WHERE id IN (SELECT value FROM json_each(?1))' });
const setBacklog = write<[backlog: number]>({ name: 'storage.setBackupRetentionBacklog', sql:
  'UPDATE backup_retention_state SET backlog=?1 WHERE slot=1' });

export interface RetentionPolicy { keepDaily: number; keepWeekly: number }
/** One keep-rule observation: the generation it read at and, while the heads are ready, a page of victims oldest first. */
export type RetentionPage = { ready: false } | { ready: true; generation: number; backlog: boolean; victims: string[] };

/** The generation and a page of victims from one read: a page never mixes rows from two generations. */
export async function readRetentionPage(db: RelationalStore, policy: RetentionPolicy, limit: number): Promise<RetentionPage> {
  const allowed = policy.keepDaily >= 1 ? limit : 0;
  const [states, victims] = await readSet(db, state.bind(), victimsPage.bind(Math.max(policy.keepDaily, 1), policy.keepWeekly, allowed));
  const held = states[0];
  if (held === undefined || held.ready !== 1) return { ready: false };
  return { ready: true, generation: held.generation, backlog: held.backlog === 1, victims: victims.map(row => row.id) };
}

export interface RetentionCommit {
  ids: readonly string[];
  policy: RetentionPolicy;
  policyAssertion: Bound;
  generation: number;
  now: number;
  /** Whether retention has more victims past this page; left unchanged when absent. */
  backlog?: boolean;
}

/**
 * Releases what the keep rule lets go of in `ids`, evaluated against the rows in this commit. The whole batch stops when the
 * policy or the keep-set generation moved after the page's read. With a recovery hold open, nothing is journaled and
 * the candidates stay recorded.
 */
export async function commitRetentionPage(db: RelationalStore, page: RetentionCommit) {
  const ids = JSON.stringify(page.ids);
  const statements = {
    policy: page.policyAssertion,
    generation: keepSetHeld.bind(page.generation),
    candidates: recordCandidates.bind(page.now, ids),
    journal: journal.bind(page.now, ids, page.policy.keepDaily, page.policy.keepWeekly),
    removed: removeRows.bind(ids),
    cleared: clearCandidates.bind(ids),
    held: stillHeld.bind(ids),
    ...(page.backlog === undefined ? {} : { backlog: setBacklog.bind(page.backlog ? 1 : 0) }),
  };
  const { removed, held } = await commitNamed(db, statements);
  return { released: removed.results.length, deferred: held.results[0]!.held };
}

export async function setRetentionBacklog(db: RelationalStore, backlog: boolean): Promise<void> {
  await commit(db, setBacklog.bind(backlog ? 1 : 0));
}

const backlogged = read<[], { backlog: number }>({ name: 'storage.backupRetentionBacklog', sql:
  'SELECT backlog FROM backup_retention_state WHERE slot=1' });

export async function retentionBacklogged(db: RelationalStore): Promise<boolean> {
  const [rows] = await readSet(db, backlogged.bind());
  return rows[0]?.backlog === 1;
}
