import type { RelationalStore } from '../../core/adapters.js';
import { objectJournalSql } from '../storage/object-journal.js';
import { assertion, commitNamed, first, refusalCode, refused, rows, write, read } from '../index.js';

/** Another restore is running; one runs at a time, so two artifacts never interleave their writes. */
const RESTORE_RUNNING = refusalCode('restore_running');
/** The backup was released, or its bytes changed, between the read that admitted it and the job that would hold it. */
const RESTORE_BACKUP_GONE = refusalCode('restore_backup_gone');

export type RestoreJobState = 'running' | 'complete' | 'failed';

export interface RestoreJobRow {
  id: string;
  /** The catalogued backup the job reads, or null for an uploaded artifact. */
  backup_id: string | null;
  /** The object an uploaded artifact is kept under while its job runs, released in the commit that ends the job. */
  upload_key: string | null;
  upload_size: number | null;
  artifact_sha256: string;
  requested_by: string;
  adopt_lineage: number;
  state: RestoreJobState;
  cursor: string;
  rows_done: number;
  rows_total: number;
  outcome: string;
  revision: number;
  accepted_at: number;
  updated_at: number;
  completed_at: number | null;
  failure: string | null;
  failure_detail: string | null;
  failed_at: number | null;
  /** How many passes in a row moved nothing; a pass that moves the restore resets it. */
  retries: number;
}

const COLUMNS = 'id,backup_id,upload_key,upload_size,artifact_sha256,requested_by,adopt_lineage,state,cursor,rows_done,rows_total,outcome,revision,accepted_at,updated_at,completed_at,failure,failure_detail,failed_at,retries';

const noneRunning = assertion<[]>({ name: 'restore.noneRunning', refusal: RESTORE_RUNNING,
  when: "NOT EXISTS(SELECT 1 FROM restore_jobs WHERE state='running')",
  detail: "(SELECT id FROM restore_jobs WHERE state='running')" });
const backupHeld = assertion<[backup: string | null, sha256: string]>({ name: 'restore.backupHeld', refusal: RESTORE_BACKUP_GONE,
  when: `?1 IS NULL OR EXISTS(SELECT 1 FROM backups b WHERE b.id=?1 AND (b.sha256 IS NULL OR b.sha256=?2)
    AND NOT EXISTS(SELECT 1 FROM object_releases r WHERE r.physical=b.key))` });
const insertJob = write<[id: string, backup: string | null, upload: string | null, size: number | null, sha256: string, by: string, adopt: number, cursor: string, total: number, outcome: string, at: number], RestoreJobRow>({
  name: 'restore.acceptJob', sql:
  `INSERT INTO restore_jobs(id,backup_id,upload_key,upload_size,artifact_sha256,requested_by,adopt_lineage,cursor,rows_total,outcome,accepted_at,updated_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11) RETURNING ${COLUMNS}` });

const byId = read<[id: string], RestoreJobRow>({ name: 'restore.job', sql: `SELECT ${COLUMNS} FROM restore_jobs WHERE id=?1` });
const running = read<[], RestoreJobRow>({ name: 'restore.runningJob', sql:
  `SELECT ${COLUMNS} FROM restore_jobs INDEXED BY idx_restore_jobs_running WHERE state='running'` });
const latest = read<[], RestoreJobRow>({ name: 'restore.latestJob', sql:
  `SELECT ${COLUMNS} FROM restore_jobs INDEXED BY idx_restore_jobs_accepted ORDER BY accepted_at DESC,id DESC LIMIT 1` });

const advance = write<[cursor: string, done: number, outcome: string, at: number, id: string, revision: number], { revision: number }>({ name: 'restore.advanceJob', sql:
  `UPDATE restore_jobs SET cursor=?1,rows_done=?2,outcome=?3,updated_at=?4,failure=NULL,failure_detail=NULL,failed_at=NULL,retries=0,revision=revision+1
    WHERE id=?5 AND revision=?6 AND state='running' RETURNING revision` });
/** The uploaded artifact's object goes to the release journal while the job still stands where its last pass left it. */
const releaseUpload = write<[id: string, revision: number, at: number]>({ name: 'restore.releaseUpload', sql:
  objectJournalSql(`SELECT upload_key,'upload',?3 FROM restore_jobs WHERE id=?1 AND revision=?2 AND state='running' AND upload_key IS NOT NULL`) });
const complete = write<[cursor: string, done: number, outcome: string, at: number, id: string, revision: number], RestoreJobRow>({ name: 'restore.completeJob', sql:
  `UPDATE restore_jobs SET cursor=?1,rows_done=?2,outcome=?3,updated_at=?4,completed_at=?4,failure=NULL,failure_detail=NULL,failed_at=NULL,retries=0,
      state='complete',revision=revision+1
    WHERE id=?5 AND revision=?6 AND state='running' RETURNING ${COLUMNS}` });
const fail = write<[failure: string, detail: string, at: number, id: string, revision: number], RestoreJobRow>({ name: 'restore.failJob', sql:
  `UPDATE restore_jobs SET failure=?1,failure_detail=?2,failed_at=?3,updated_at=?3,completed_at=?3,state='failed',revision=revision+1
    WHERE id=?4 AND revision=?5 AND state='running' RETURNING ${COLUMNS}` });
const noteRetry = write<[failure: string, at: number, id: string, revision: number, counts: number], { retries: number }>({ name: 'restore.noteRetry', sql:
  `UPDATE restore_jobs SET retries=retries+?5,failure=?1,failure_detail=NULL,failed_at=?2,updated_at=?2
    WHERE id=?3 AND revision=?4 AND state='running' RETURNING retries` });

export interface RestoreJobAccept {
  id: string;
  /** The catalogued backup the job reads; or `upload`, the object an uploaded artifact is kept under. */
  source: { backupId: string } | { upload: { key: string; size: number } };
  sha256: string;
  requestedBy: string;
  adoptLineage: boolean;
  cursor: string;
  rowsTotal: number;
  outcome: string;
  now: number;
}

/**
 * Records an admitted restore as the job that owns it, in one commit that also holds a catalogued backup it reads: the
 * backup must still be catalogued with the bytes the admission read and not released, and no other restore may be
 * running. Answers the job, or the refusal that named why none was recorded.
 */
export async function recordRestoreJob(db: RelationalStore, accept: RestoreJobAccept): Promise<
  { job: RestoreJobRow } | { refused: 'running'; runningId: string | null } | { refused: 'backup_gone' }> {
  const backupId = 'backupId' in accept.source ? accept.source.backupId : null;
  const upload = 'upload' in accept.source ? accept.source.upload : null;
  try {
    const { job } = await commitNamed(db, {
      none: noneRunning.bind(),
      held: backupHeld.bind(backupId, accept.sha256),
      job: insertJob.bind(accept.id, backupId, upload?.key ?? null, upload?.size ?? null, accept.sha256, accept.requestedBy, accept.adoptLineage ? 1 : 0,
        accept.cursor, accept.rowsTotal, accept.outcome, accept.now),
    });
    return { job: job.results[0]! };
  } catch (error) {
    if (refused(error, RESTORE_RUNNING)) return { refused: 'running', runningId: (await runningRestoreJob(db))?.id ?? null };
    if (refused(error, RESTORE_BACKUP_GONE)) return { refused: 'backup_gone' };
    throw error;
  }
}

export const restoreJob = (db: RelationalStore, id: string): Promise<RestoreJobRow | null> => first(db, byId.bind(id));
export const runningRestoreJob = (db: RelationalStore): Promise<RestoreJobRow | null> => first(db, running.bind());
export const latestRestoreJob = (db: RelationalStore): Promise<RestoreJobRow | null> => first(db, latest.bind());

/** What a pass of a job leaves: where the next starts, how many rows it has walked, and what it has added so far. */
export interface RestoreJobPass { cursor: string; rowsDone: number; outcome: string; now: number }

/** Moves the job to where its pass left it, if the job still stands at the revision the pass read; answers the new revision, or null when it moved. */
export async function advanceRestoreJob(db: RelationalStore, job: Pick<RestoreJobRow, 'id' | 'revision'>, pass: RestoreJobPass): Promise<number | null> {
  return (await rows(db, advance.bind(pass.cursor, pass.rowsDone, pass.outcome, pass.now, job.id, job.revision)))[0]?.revision ?? null;
}

/** Ends the job complete with its final outcome, releasing an uploaded artifact's object, if the job still stands at the revision its last pass read. */
export async function completeRestoreJob(db: RelationalStore, job: Pick<RestoreJobRow, 'id' | 'revision'>, pass: RestoreJobPass): Promise<RestoreJobRow | null> {
  const { ended } = await commitNamed(db, {
    release: releaseUpload.bind(job.id, job.revision, pass.now),
    ended: complete.bind(pass.cursor, pass.rowsDone, pass.outcome, pass.now, job.id, job.revision),
  });
  return ended.results[0] ?? null;
}

/**
 * Ends the job failed with the refusal its pass met, or the owner's stop, keeping the outcome of the passes before it
 * and releasing an uploaded artifact's object, if the job still stands at `revision`. Null when it moved or ended.
 */
export async function failRestoreJob(db: RelationalStore, job: Pick<RestoreJobRow, 'id' | 'revision'>, failure: { code: string; detail: string; now: number }): Promise<RestoreJobRow | null> {
  const { ended } = await commitNamed(db, {
    release: releaseUpload.bind(job.id, job.revision, failure.now),
    ended: fail.bind(failure.code, failure.detail, failure.now, job.id, job.revision),
  });
  return ended.results[0] ?? null;
}

/**
 * Names why a pass left the job where it stood. `counts` adds the pass to the passes in a row that moved nothing; a
 * wait that is not the job's to end (an owner's request, an upload still landing) does not. Answers that count, or null
 * when the job moved.
 */
export async function noteRestoreRetry(db: RelationalStore, job: Pick<RestoreJobRow, 'id' | 'revision'>, errorClass: string, now: number, counts: boolean): Promise<number | null> {
  return (await rows(db, noteRetry.bind(errorClass, now, job.id, job.revision, counts ? 1 : 0)))[0]?.retries ?? null;
}
