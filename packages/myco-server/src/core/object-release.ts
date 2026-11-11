import { MemberWriteRefused } from '../auth/member-write-refusal.js';
import { beginBackupPublication, publishBackup, abandonBackupPublication, backupObjectRegistered } from '../db/storage/backup-publication.js';
import type { BackupIndexRow } from './backup.js';
import { BLOB_RESERVATION_TTL_MS } from '../constants.js';
/**
 * The one owner of stored-object deletion.
 *
 * A caller never deletes stored bytes. It *releases* them: one transaction decides, from the rows as they stand, which
 * objects nothing registers any more, records each by its physical key in `object_releases`, and removes the row that
 * registered it. The release owner is the only code that asks the store to delete, and it removes a journal row only once the
 * store acknowledged that delete.
 *
 * Each physical key has one writer. An upload stores under its own generation
 * (`core/blob-objects.ts`), a backup under its own id, a restore under its own generation. A delete that lands late,
 * twice, or from a replaced instance can only remove bytes already released, never bytes a later write
 * stored under the same content.
 *
 * A deletion records what it may have freed as release candidates, in the transaction that removes the rows naming it;
 * a decision then journals what nothing references. While a recovery hold is open nothing registered is journaled: the
 * candidates stay recorded, and a decision after the hold judges them against the rows as they stand then. Unregistered upload bytes are never in a snapshot, so their
 * journal is not held.
 */
import type { BlobStore, RelationalStore, ServerEnv } from './adapters.js';
import { BLOB_REFERENCES, referencedBlobValue, type BlobRef } from './blob-references.js';
import { within } from './recovery-inventory.js';
import { continueBackupRetention, decideBackupCandidates } from './backup-retention.js';
import { drainAuthorities, dueObjectReleases, acknowledgeRelease, retryRelease, reconcileObjectIntents, releaseWorkDue,
  resetObjectLifecycle, settleObjectIntent } from '../db/storage/object-lifecycle.js';
import { resetOrphanAudit } from '../db/storage/blob-orphan-audit.js';
import { reconcileStoredObjects } from '../db/storage/object-reconciliation.js';
import { retentionBacklogged } from '../db/storage/backup-retention.js';
import { RELEASE_PAGE, decideRecordedBlobs, releaseCandidatesDue, type ReleaseOutcome } from '../db/storage/release-queue.js';
import { classify, emit } from '../telemetry.js';

/** Journal rows, expired authorities and deferred candidates one drain pass takes, each. */
export const DRAIN_PAGE = 16;
/** How long one store delete may take before the drain leaves its journal row for the next pass. */
const DRAIN_DELETE_MS = 15_000;
const DRAIN_FAILURE_LIMIT = 2;

const deleteStoredObject = (blobs: BlobStore, key: string, clock: () => number = Date.now) => within(() => blobs.delete(key), DRAIN_DELETE_MS, clock);

/** A private backup key retains an intent until its PUT and index publication settle. */
export async function publishBackupObject(db: RelationalStore, blobs: BlobStore, key: string, upload: () => Promise<{ size: number }>,
  index: (size: number) => BackupIndexRow): Promise<BackupIndexRow> {
  await beginBackupPublication(db,key,Date.now()+BLOB_RESERVATION_TTL_MS);
  let settled = false;
  try {
    const stored = await upload();
    settled = true;
    const row = index(stored.size);
    if (row.key !== key) throw new Error('backup publication key does not match its upload authority');
    await publishBackup(db,row,Date.now());
    await settleObjectIntent(db,key,Date.now(),true);
    return row;
  } catch (error) {
    try {
      if (error instanceof MemberWriteRefused && settled) {
        // Terminal refusal permits discarding settled private bytes only while no backup registers their key.
        if (!await backupObjectRegistered(db,key)) await deleteStoredObject(blobs,key);
      } else {
        await abandonBackupPublication(db,key,Date.now());
        await settleObjectIntent(db,key,Date.now(),settled);
      }
    } catch (cleanupError) {
      emit({ kind: 'backup_publication_cleanup_failed', key, error_class: classify(cleanupError) });
    }
    throw error;
  }
}

/**
 * Decides the candidates `pairs` name, one transaction per page. A caller records them first, in the batch that removes
 * the rows naming them; this call never observes a registration itself, so a key released and registered again after
 * that batch is out of its reach.
 */
export async function releaseBlobs(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: 0, deferred: 0 };
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const page = await decideRecordedBlobs(db, pairs.slice(at, at + RELEASE_PAGE), now);
    outcome.released += page.released;
    outcome.deferred += page.deferred;
  }
  return outcome;
}

/** The blobs a row of `table` names through the reference catalogue, as the rows it carries state them. */
export function referencedBlobsOf(table: string, row: Readonly<Record<string, unknown>>, presence: 'all' | 'required' | 'report' = 'all'): BlobRef[] {
  const projectId = row.project_id;
  if (typeof projectId !== 'string') return [];
  return BLOB_REFERENCES.filter((ref) => ref.table === table
    && (presence === 'all' || (ref.onMissing === 'report') === (presence === 'report'))
    && typeof referencedBlobValue(ref,row) === 'string'
    && (ref.kinds === undefined || ref.kinds.includes(row.kind as string)))
    .map((ref) => ({ projectId, key: referencedBlobValue(ref,row) as string }));
}

interface DrainReport {
  /** Expired upload authorities consumed, their bytes journaled. */
  expired: number;
  /** Journal rows the store acknowledged deleting, and removed. */
  deleted: number;
  /** Recorded release candidates decided and removed. */
  decided: number;
  /** A store delete that failed or passed its deadline; its row stays for the next pass. */
  unacknowledged: number;
}

/**
 * One bounded pass of the only store deleter:
 * 1. walk one page of the object store and consume a page of expired upload authorities, journaling what no owner holds;
 * 2. delete a page of journaled objects due now, removing each journal row only after the store acknowledged its delete;
 *    a failed delete moves only its own key to a later attempt, so the key behind it is reached;
 * 3. with no hold open, decide a page of recorded release candidates through the same statements a release runs,
 *    asking the retention owner which backups the policy in force lets go of, and continuing a retention pass that ran out of pages.
 *
 * Its safety does not rest on running alone: a delete issued twice, late, or by a replaced instance names a key no
 * write will produce again, and a journal row is removed by its primary key.
 */
export async function drainObjectReleases(
  env: Pick<ServerEnv, 'db' | 'blobs'> & Partial<Pick<ServerEnv, 'platform'>>, now: number, clock: () => number = Date.now,
): Promise<DrainReport> {
  const { db } = env;
  const report: DrainReport = { expired: 0, deleted: 0, decided: 0, unacknowledged: 0 };

  await reconcileObjectIntents(db,now,DRAIN_PAGE);
  try {
    const walked = await reconcileStoredObjects(env,now);
    if (walked.released + walked.ownerless + walked.vectorPages > 0) emit({ kind: 'stored_objects_reconciled', ...walked });
  } catch (error) {
    // The store walk is resumable and the rest of this pass does not depend on it; the next wake revisits this page.
    emit({ kind: 'object_store_reconcile_failed', error_class: classify(error,env.platform?.classifyError) });
  }
  report.expired = await drainAuthorities(db,now,DRAIN_PAGE);
  const journal = await dueObjectReleases(db,now,DRAIN_PAGE);
  let consecutiveFailures=0;
  for (const { physical, attempts } of journal) {
    const issuedAt=clock();
    try {
      await deleteStoredObject(env.blobs, physical, clock);
    } catch (error) {
      report.unacknowledged += 1;
      const errorClass=classify(error,env.platform?.classifyError);
      await retryRelease(db,physical,now,attempts,errorClass);
      emit({ kind: 'object_release_unacknowledged', error_class: errorClass });
      consecutiveFailures+=1;
      if (consecutiveFailures>=DRAIN_FAILURE_LIMIT || ['db','rpc','store_quota','configuration'].includes(errorClass)) break;
      continue;
    }
    consecutiveFailures=0;
    report.deleted += await acknowledgeRelease(db,physical,issuedAt);
  }

  const due = await releaseCandidatesDue(db,now,DRAIN_PAGE);
  if (due.held) return report;
  if (due.blobs.length > 0) report.decided += (await decideRecordedBlobs(db,due.blobs,now)).decided;
  if (due.backups.length > 0) report.decided += await decideBackupCandidates(db,due.backups,now);
  await continueBackupRetention(db,now);
  return report;
}

/**
 * Whether the drain has more than one pass took: expired authorities, journal rows due now, or candidates due with no
 * hold open. A failed delete answers no: its key waits for its own retry and the next wake.
 */
export async function objectReleaseBacklogged(db: RelationalStore, now: number, report: DrainReport): Promise<boolean> {
  if (report.unacknowledged > 0) return false;
  const [due, work, retention] = await Promise.all([releaseCandidatesDue(db,now,1),releaseWorkDue(db,now),retentionBacklogged(db)]);
  return work || (!due.held && (due.blobs.length > 0 || due.backups.length > 0 || retention));
}

/**
 * Clears what a restored database carries of its source's object lifecycle, on the prepared copy before it is
 * published: the source's holds, journal and upload authorities belong to the source's store, and a restored open hold
 * would defer every release at the destination. Blob release candidates are kept: each is judged again against the
 * rows before anything is released. Backup candidates are dropped: backup retention decides again at the destination.
 */
export async function resetRecoveryLedger(db: RelationalStore): Promise<void> {
  await resetObjectLifecycle(db);
  await resetOrphanAudit(db, Date.now());
}
