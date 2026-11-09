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
import { retentionDecision } from './backup-retention.js';
import { commitBackupRelease, type RetentionObservation } from '../db/storage/backup-retention.js';
import { drainAuthorities, dueObjectReleases, acknowledgeRelease, retryRelease, reconcileObjectIntents, releaseWorkDue,
  resetObjectLifecycle, settleObjectIntent } from '../db/storage/object-lifecycle.js';
import { resetOrphanAudit } from '../db/storage/blob-orphan-audit.js';
import { reconcileStoredObjects } from '../db/storage/object-reconciliation.js';
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

/**
 * Records and decides one revision-bound backup release batch. With no hold open, each unpinned victim's object
 * is journaled with its row removed, and the batch's candidates are cleared. With a hold open the candidates remain
 * for the drain, which asks the retention owner again.
 */
export async function releaseBackups(db: RelationalStore, ids: readonly string[], victims: ReadonlySet<string>,
  now: number, observed: RetentionObservation): Promise<ReleaseOutcome> {
  return commitBackupRelease(db,ids,victims,observed,now);
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

/** Who took a hold: this Deployment's own export producer, or an operator's full backup. */
type RecoveryHoldHolder = 'producer' | 'operator';
/** Why an operator released its hold: the artifact completed, or the operator gave it up. */
export type OperatorHoldRelease = 'complete' | 'abandoned';

/** A hold row as an inspection reads it. */
interface RecoveryHoldRow {
  token: string;
  holder: RecoveryHoldHolder;
  acquiredAt: number;
  releasedAt: number | null;
  releaseReason: string | null;
}

/**
 * How long an open operator hold defers this Deployment's own exports. An operator backup runs for minutes to hours;
 * one open longer than a day has been abandoned without its release, and automatic backups do not wait on it for ever.
 * Deletion still defers to it until it is released.
 */
export const OPERATOR_HOLD_DEFERS_MS = 24 * 60 * 60 * 1000;

/** The open operator hold this Deployment's exports defer to now, or null. */
export async function deferringOperatorHold(db: RelationalStore, now: number): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await db.prepare(recoveryHoldSql.deferringOperator(now)).first<{ token: string; acquired_at: number }>();
  return row === null ? null : { token: row.token, acquiredAt: Number(row.acquired_at) };
}

/**
 * Every statement of a hold's lifecycle, rendered here and nowhere else, so both targets and both holders transition a
 * hold the same way. A hosted operator sends these through the provider's own command path, which binds no parameters,
 * so the values are rendered into the statement: a token is a UUID, a holder and a reason are from closed sets, and an
 * instant is a number. Anything else is refused before a statement exists.
 */
export const recoveryHoldSql = {
  acquire(held: string, now: number, holder: RecoveryHoldHolder): string {
    // A producer defers to an operator backup opened in the last day, decided in the same statement that opens its
    // hold. The operator opens its hold first and then reads for the producer's, and writes are serialized, so of two
    // that race exactly one sees the other and neither exports beside it.
    const deferring = holder === 'producer'
      ? ` AND NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL AND holder = 'operator' AND acquired_at > ${instant(Math.max(0, now - OPERATOR_HOLD_DEFERS_MS))})`
      : '';
    return `INSERT INTO recovery_holds (token, acquired_at, holder)
              SELECT ${token(held)}, ${instant(now)}, '${holder}'
               WHERE NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}')${deferring}
              ON CONFLICT DO NOTHING`;
  },
  /** The open operator hold a producer defers to now, if any. */
  deferringOperator(now: number): string {
    return `SELECT token, acquired_at FROM recovery_holds WHERE released_at IS NULL AND holder = 'operator' AND acquired_at > ${instant(Math.max(0, now - OPERATOR_HOLD_DEFERS_MS))}`;
  },
  releaseProducer(held: string, now: number, why: string): string {
    return `UPDATE recovery_holds SET released_at = ${instant(now)}, release_reason = ${reason(why)}, released_by = 'producer'
             WHERE token = ${token(held)} AND released_at IS NULL AND holder = 'producer'`;
  },
  releaseOperator(held: string, now: number, why: OperatorHoldRelease): string {
    if (why !== 'complete' && why !== 'abandoned') throw new Error('an operator recovery hold is released as complete or abandoned');
    return `UPDATE recovery_holds SET released_at = ${instant(now)}, release_reason = '${why}', released_by = 'operator'
             WHERE token = ${token(held)} AND released_at IS NULL AND holder = 'operator'`;
  },
  /**
   * One row answering what a hold token is and what Deployment holds it, so a caller never pairs a hold with an
   * identity it read separately.
   */
  reading(held: string): string {
    return `SELECT (SELECT holder FROM recovery_holds WHERE token = ${token(held)}) AS holder,
                   (SELECT acquired_at FROM recovery_holds WHERE token = ${token(held)}) AS acquired_at,
                   (SELECT released_at FROM recovery_holds WHERE token = ${token(held)}) AS released_at,
                   (SELECT release_reason FROM recovery_holds WHERE token = ${token(held)}) AS release_reason,
                   (SELECT value FROM schema_meta WHERE key = 'deployment_id') AS deployment_id,
                   (SELECT value FROM schema_meta WHERE key = 'version') AS schema_version`;
  },
  open(holder: RecoveryHoldHolder): string {
    return `SELECT token, acquired_at FROM recovery_holds WHERE released_at IS NULL AND holder = '${holder}'`;
  },
};

/** A hold token: what `crypto.randomUUID` mints, and nothing that could carry a quote into a statement. */
const HOLD_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
/** A release reason: the producer's settled attempt, or an operator's completion or abandonment. */
const RELEASE_REASON = /^[A-Za-z0-9 ._-]{1,64}$/;

function token(value: string): string {
  if (!HOLD_TOKEN.test(value)) throw new Error('a recovery hold token is outside its grammar');
  return `'${value}'`;
}
function reason(value: string): string {
  if (!RELEASE_REASON.test(value)) throw new Error('a recovery hold release reason is outside its grammar');
  return `'${value}'`;
}
function instant(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('a recovery hold instant is a whole number of milliseconds');
  return String(value);
}

/** What one `recoveryHoldSql.reading` row says: the hold, and the Deployment that answered for it. */
interface RecoveryHoldReadingRow {
  holder: string | null;
  acquired_at: number | null;
  released_at: number | null;
  release_reason: string | null;
  deployment_id: string | null;
  schema_version: string | null;
}

/**
 * Opens a hold of `holder` under `token`, answering false when one of that holder is already open: at most one of each
 * holder is open, and the unique index on open holds per holder decides it inside the insert. A token already used
 * answers false too, so retrying the same token is safe and never opens a second hold.
 *
 * An operator hold and a producer hold coexist: a full operator backup does not stop this Deployment admitting its own
 * export, and deletion defers while either is open (`HOLD_OPEN`).
 */
export async function acquireRecoveryHold(db: RelationalStore, token: string, now: number, holder: RecoveryHoldHolder = 'producer'): Promise<boolean> {
  const inserted = await db.prepare(recoveryHoldSql.acquire(token, now, holder)).run();
  return inserted.meta.changes === 1;
}

/**
 * Releases the open producer hold `token` with its reason, answering whether this call released it. A released hold
 * stays released, and an operator hold is never released here: the database refuses it.
 */
export async function releaseRecoveryHold(db: RelationalStore, token: string, now: number, reason: string): Promise<boolean> {
  const released = await db.prepare(recoveryHoldSql.releaseProducer(token, now, reason)).run();
  return released.meta.changes === 1;
}

/**
 * Releases the open operator hold `token`, answering whether this call released it. The one transition an operator hold
 * accepts; a released hold stays released, so a repeated release is safe.
 */
export async function releaseOperatorHold(db: RelationalStore, token: string, now: number, reason: OperatorHoldRelease): Promise<boolean> {
  const released = await db.prepare(recoveryHoldSql.releaseOperator(token, now, reason)).run();
  return released.meta.changes === 1;
}

/**
 * The Deployment a hold reading answers for: what a destination binds its backup to.
 *
 * Both fields come from the same statement as the hold. A reading that cannot name both is `null`, never a partly
 * filled identity.
 */
export interface RecoveryHoldSource {
  deploymentId: string;
  schemaVersion: number;
}

/** The hold `token` names and the Deployment answering for it, as one row. */
export async function readRecoveryHold(db: RelationalStore, token: string): Promise<{ hold: RecoveryHoldRow | null; source: RecoveryHoldSource | null }> {
  const row = await db.prepare(recoveryHoldSql.reading(token)).first<RecoveryHoldReadingRow>();
  return recoveryHoldOf(token, row);
}

/** One reading row as a hold and the identity it came with; the identity is what a destination binds its hold to. */
export function recoveryHoldOf(token: string, row: RecoveryHoldReadingRow | null): { hold: RecoveryHoldRow | null; source: RecoveryHoldSource | null } {
  const source = recoveryHoldSourceOf(row);
  if (row === null || row.holder === null) return { hold: null, source };
  return {
    hold: { token, holder: row.holder as RecoveryHoldHolder, acquiredAt: Number(row.acquired_at), releasedAt: row.released_at, releaseReason: row.release_reason },
    source,
  };
}

/** The identity a reading row carries, or null when it names no Deployment or no schema version this code can read. */
function recoveryHoldSourceOf(row: Pick<RecoveryHoldReadingRow, 'deployment_id' | 'schema_version'> | null): RecoveryHoldSource | null {
  const deploymentId = row?.deployment_id ?? null;
  const schemaVersion = Number(row?.schema_version ?? Number.NaN);
  if (deploymentId === null || deploymentId === '' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) return null;
  return { deploymentId, schemaVersion };
}

/** The open hold of `holder`, or null. */
export async function openRecoveryHold(db: RelationalStore, holder: RecoveryHoldHolder): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await db.prepare(recoveryHoldSql.open(holder)).first<{ token: string; acquired_at: number }>();
  return row === null ? null : { token: row.token, acquiredAt: Number(row.acquired_at) };
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
 *    asking the retention owner which backups the policy in force lets go of.
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
  if (due.backups.length > 0) {
    const { victims, observed } = await retentionDecision(db);
    const outcome = await commitBackupRelease(db,due.backups,victims,observed,now);
    report.decided += due.backups.length - outcome.deferred;
  }
  return report;
}

/**
 * Whether the drain has more than one pass took: expired authorities, journal rows due now, or candidates due with no
 * hold open. A failed delete answers no: its key waits for its own retry and the next wake.
 */
export async function objectReleaseBacklogged(db: RelationalStore, now: number, report: DrainReport): Promise<boolean> {
  if (report.unacknowledged > 0) return false;
  const [due, work] = await Promise.all([releaseCandidatesDue(db,now,1),releaseWorkDue(db,now)]);
  return work || (!due.held && (due.blobs.length > 0 || due.backups.length > 0));
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
