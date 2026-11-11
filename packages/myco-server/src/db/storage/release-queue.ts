import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { blobObjectKeySql } from '../../core/blob-objects.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import type { BlobRef } from '../../core/blob-references.js';
import { commit, commitNamed, read, readSet, write, type Bound } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { blobHeld } from './blob-held.js';
import { objectJournalSql } from './object-journal.js';

/** SQL true while a recovery hold is open. */
export const HOLD_OPEN = 'EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL)';
/** Candidates one release statement judges, bound as one JSON parameter. */
export const RELEASE_PAGE = 64;

export interface ReleaseOutcome {
  /** Registered objects journaled for deletion, their rows removed. */
  released: number;
  /** Candidates an open hold keeps, recorded for a decision after it. */
  deferred: number;
}

/** What binds a blob candidate to the preparation whose evidence is being released: `agedAt` is set only for an aged-only release. */
interface PreparationGuard {
  preparationId: string; projectId: string; archiveKey: string; receiptKey: string | null; expiresAt: number; agedAt: number | null;
}

/**
 * What a bundle's candidates are recorded against: the preparation or the bundle, still standing. A caller that read the
 * references itself records through `recordObservedCandidates`.
 */
type CandidateGuard = PreparationGuard | { bundle: { projectId: string; bundleId: number; archiveKey: string } };

/** A registration an aged orphan sweep read: the generation it saw, and nothing newer. */
export interface ObservedOrphan extends BlobRef { generation: string | null }

const pageOf = (pairs: readonly BlobRef[]): string => JSON.stringify(pairs.map(b => ({ p: b.projectId, k: b.key })));
const PAGE = `(SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k FROM json_each(?1) j)`;
const physical = (alias: string) => blobObjectKeySql(`${alias}.project_id`, `${alias}.key`, `${alias}.generation`);
/** The candidate authorizes only the registration it observed; a `'*'` candidate waits for its blob to age past the orphan grace. */
const candidate = (alias: string) => `EXISTS(SELECT 1 FROM blob_release_candidates rc WHERE rc.project_id=${alias}.project_id AND rc.key=${alias}.key
  AND ${alias}.generation IS rc.generation)`;
const REOBSERVE = 'ON CONFLICT(project_id,key) DO UPDATE SET generation=excluded.generation';

/** A key's registration as a bundle's proof names it: the generation that bundle or receipt holds, and only while it is still registered. */
const BUNDLE_PROOF = (archive: string) => `JOIN registered_content_proofs p ON p.project_id=c.p AND p.key=c.k
      AND ((p.source_kind='bundle' AND p.source_id=${archive}) OR (p.source_kind='receipt' AND p.source_id='bundle:'||${archive}))
    JOIN blobs b ON b.project_id=c.p AND b.key=c.k AND b.generation IS p.generation`;
const recordForPreparation = write<[page: string, now: number, preparation: string, project: string, archive: string, receipt: string | null, expires: number, aged: number | null]>({
  name: 'storage.recordPreparationBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT c.p,c.k,?2,b.generation FROM ${PAGE} c ${BUNDLE_PROOF('?5')}
    WHERE EXISTS(SELECT 1 FROM prepared_archive_bundles pb WHERE pb.preparation_id=?3 AND pb.project_id=?4 AND pb.archive_key=?5
      AND pb.receipt_key IS ?6 AND pb.expires_at=?7 AND (?8 IS NULL OR pb.expires_at<=?8))
    ${REOBSERVE}` });
const recordObserved = write<[page: string, now: number]>({ name: 'storage.recordObservedBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
    SELECT b.project_id,b.key,?2,b.generation FROM (SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k,json_extract(j.value,'$.g') AS g FROM json_each(?1) j) c
    JOIN blobs b ON b.project_id=c.p AND b.key=c.k WHERE b.generation IS c.g
    ${REOBSERVE}` });
const recordForBundle = write<[page: string, now: number, project: string, bundle: number, archive: string]>({ name: 'storage.recordBundleBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT c.p,c.k,?2,b.generation FROM ${PAGE} c ${BUNDLE_PROOF('?5')}
    WHERE EXISTS(SELECT 1 FROM archive_bundles a WHERE a.project_id=?3 AND a.id=?4 AND a.archive_key=?5)
    ${REOBSERVE}` });
/**
 * A holder records the generation its own proof names, so a holder with no proof records nothing. A blob still inside the
 * upload grace may be a member's upload whose event has not arrived, whoever registered it: its candidate waits out the
 * grace as `'*'`, due when the grace ends so it cannot hold the queue's head, and is then judged like any other.
 */
const recordForHolders = write<[page: string, now: number, cutoff: number]>({ name: 'storage.recordHolderBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
    SELECT r.project_id,r.blob_key,CASE WHEN b.received_at<=?3 THEN ?2 ELSE b.received_at+(?2-?3) END,CASE WHEN b.received_at<=?3 THEN b.generation ELSE '*' END FROM json_each(?1) j
      JOIN retired_objects r ON r.project_id=json_extract(j.value,'$.p') AND r.session_id=json_extract(j.value,'$.s')
        AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i')
      JOIN registered_content_proofs p ON p.project_id=r.project_id AND p.key=r.blob_key AND p.source_kind='document' AND p.source_id=r.source_id
      JOIN blobs b ON b.project_id=r.project_id AND b.key=r.blob_key AND b.generation IS p.generation WHERE true
    ${REOBSERVE}` });
const recordAgedOrphans = write<[page: string, now: number, cutoff: number]>({ name: 'storage.recordAgedOrphans', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
    SELECT b.project_id,b.key,?2,b.generation FROM (SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k,json_extract(j.value,'$.g') AS g FROM json_each(?1) j) c
    JOIN blobs b ON b.project_id=c.p AND b.key=c.k WHERE b.generation IS c.g AND b.received_at<=?3
    ${REOBSERVE}` });
const journalUnreferenced = write<[page: string, now: number]>({ name: 'storage.journalUnreferencedBlobs', sql:
  objectJournalSql(`SELECT ${physical('b')},'blob',?2 FROM ${PAGE} c JOIN blobs b ON b.project_id=c.p AND b.key=c.k
    WHERE NOT ${HOLD_OPEN} AND ${candidate('b')} AND NOT (${blobHeld('c.p', 'c.k')})`) });
const removeJournaled = write<[page: string], { key: string }>({ name: 'storage.removeJournaledBlobs', sql:
  `DELETE FROM blobs WHERE (project_id,key) IN (SELECT c.p,c.k FROM ${PAGE} c)
    AND EXISTS(SELECT 1 FROM object_releases r WHERE r.physical=${physical('blobs')}) RETURNING key` });
/** A `'*'` candidate takes the generation of a blob past the orphan grace, the same judgement the orphan sweep makes. */
const observeAgedLegacy = write<[page: string, cutoff: number]>({ name: 'storage.observeAgedLegacyCandidates', sql:
  `UPDATE blob_release_candidates SET generation=(SELECT b.generation FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key)
    WHERE generation='*' AND (project_id,key) IN (SELECT c.p,c.k FROM ${PAGE} c)
      AND EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key AND b.received_at<=?2)` });
/** A `'*'` candidate whose blob is still inside the grace moves its due instant to where the grace ends, so it no longer holds the head of the queue. */
const deferYoungLegacy = write<[page: string, cutoff: number, grace: number]>({ name: 'storage.deferYoungLegacyCandidates', sql:
  `UPDATE blob_release_candidates SET created_at=(SELECT b.received_at+?3 FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key)
    WHERE generation='*' AND (project_id,key) IN (SELECT c.p,c.k FROM ${PAGE} c)
      AND EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key AND b.received_at>?2)` });
const clearDecided = write<[page: string], { key: string }>({ name: 'storage.clearDecidedBlobCandidates', sql:
  `DELETE FROM blob_release_candidates WHERE NOT ${HOLD_OPEN} AND (project_id,key) IN (SELECT c.p,c.k FROM ${PAGE} c)
    AND NOT (generation IS '*' AND EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key)) RETURNING key` });
const heldCandidates = read<[page: string], { held: number }>({ name: 'storage.heldBlobCandidates', sql:
  `SELECT COUNT(*) AS held FROM blob_release_candidates rc WHERE (rc.project_id,rc.key) IN (SELECT c.p,c.k FROM ${PAGE} c)` });

const decision = (page: string, now: number, deleteDueAt = now) => ({
  observe: observeAgedLegacy.bind(page, now - BLOB_RESERVATION_TTL_MS),
  defer: deferYoungLegacy.bind(page, now - BLOB_RESERVATION_TTL_MS, BLOB_RESERVATION_TTL_MS),
  journal: journalUnreferenced.bind(page, deleteDueAt), removed: removeJournaled.bind(page), cleared: clearDecided.bind(page), held: heldCandidates.bind(page),
});

/**
 * Statements that record a bundle's `pairs` as blob release candidates, one per page, placed ahead of the statements that
 * remove the rows naming them. Each candidate holds the generation the bundle's own proof names, and is recorded only
 * while `guard` stands. Recorded in that same transaction, a candidate outlives any interruption before it is decided:
 * the drain decides what a caller did not.
 */
export function recordBlobCandidates(pairs: readonly BlobRef[], now: number, guard: CandidateGuard): Bound<never, 'write'>[] {
  const statements: Bound<never, 'write'>[] = [];
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const page = pageOf(pairs.slice(at, at + RELEASE_PAGE));
    statements.push('preparationId' in guard ? recordForPreparation.bind(page, now, guard.preparationId, guard.projectId, guard.archiveKey, guard.receiptKey, guard.expiresAt, guard.agedAt)
      : recordForBundle.bind(page, now, guard.bundle.projectId, guard.bundle.bundleId, guard.bundle.archiveKey));
  }
  return statements;
}

/** Statements that record blobs whose references a caller read together with their generations, each only while that generation is still registered. */
export function recordObservedCandidates(db: RelationalStore, observed: readonly ObservedOrphan[], now: number): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (let at = 0; at < observed.length; at += RELEASE_PAGE) {
    statements.push(prepareBound(db, recordObserved.bind(JSON.stringify(observed.slice(at, at + RELEASE_PAGE).map(b => ({ p: b.projectId, k: b.key, g: b.generation }))), now)));
  }
  return statements;
}

/** A retired chunk holder, as a caller read it. */
interface HolderRef { p: string; s: string; k: string; i: string }

/** Statements that record the blobs of those holders that still stand, ahead of the statement removing them. */
export function recordHolderCandidates(holders: readonly HolderRef[], now: number): Bound[] {
  const statements: Bound[] = [];
  for (let at = 0; at < holders.length; at += RELEASE_PAGE) statements.push(recordForHolders.bind(JSON.stringify(holders.slice(at, at + RELEASE_PAGE)), now, now - BLOB_RESERVATION_TTL_MS));
  return statements;
}

interface BlobDecision extends ReleaseOutcome {
  /** Candidates this decision took out of the queue, released or not. */
  decided: number;
}

/**
 * Decides one page of recorded candidates in one transaction:
 * - with no hold open, journal each unreferenced registration its candidate observed, remove exactly the rows whose own
 *   object is journaled, and remove every candidate of the page, whether it released or not, a `'*'` candidate whose blob
 *   is still inside the orphan grace aside;
 * - with a hold open, the candidates stay recorded, and nothing else changes.
 *
 * A candidate never reaches a registration newer than the one it observed. A reference committed first holds its blob
 * here; a reference arriving after is refused by the admission every reference writer carries: the row is gone.
 */
export async function decideRecordedBlobs(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<BlobDecision> {
  const page = pageOf(pairs);
  const { removed, cleared, held } = await commitNamed(db, decision(page, now));
  return { released: removed.results.length, deferred: held.results[0]!.held, decided: cleared.results.length };
}

/**
 * Releases orphans an earlier read found aged and unreferenced. Each is recorded only while the row still holds the
 * generation read and is at or past `cutoff`, in the commit that decides it; a hold keeps that candidate for later.
 * `deleteDueAt` is when the store delete of what this releases falls due, now unless a caller delays it. `fence`, when
 * given, must hold in each deciding commit.
 */
export async function releaseAgedOrphans(db: RelationalStore, observed: readonly ObservedOrphan[], now: number, cutoff: number, options: { deleteDueAt?: number; fence?: Bound } = {}): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: 0, deferred: 0 };
  for (let at = 0; at < observed.length; at += RELEASE_PAGE) {
    const page = JSON.stringify(observed.slice(at, at + RELEASE_PAGE).map(b => ({ p: b.projectId, k: b.key, g: b.generation })));
    const statements = { record: recordAgedOrphans.bind(page, now, cutoff), ...decision(page, now, options.deleteDueAt ?? now) };
    const { removed, held } = options.fence === undefined ? await commitNamed(db, statements) : await commitNamed(db, { fence: options.fence, ...statements });
    outcome.released += removed.results.length;
    outcome.deferred += held.results[0]!.held;
  }
  return outcome;
}

const holdIsOpen = read<[], { held: number }>({ name: 'storage.releaseHoldOpen', sql: `SELECT ${HOLD_OPEN} AS held` });
/** Candidates due now, oldest first: a `'*'` candidate waiting out its grace is due only when it ends. */
const blobsDue = read<[now: number, limit: number], { project_id: string; key: string }>({ name: 'storage.blobCandidatesDue', sql:
  'SELECT project_id,key FROM blob_release_candidates WHERE created_at<=?1 ORDER BY created_at,project_id,key LIMIT ?2' });
const backupsDue = read<[limit: number], { id: string }>({ name: 'storage.backupCandidatesDue', sql:
  'SELECT id FROM backup_release_candidates ORDER BY created_at,id LIMIT ?' });

/** The next candidates of each ordered queue; `held` while a recovery hold keeps every one of them recorded. */
export async function releaseCandidatesDue(db: RelationalStore, now: number, limit: number): Promise<{ held: boolean; blobs: BlobRef[]; backups: string[] }> {
  const [hold, blobs, backups] = await readSet(db, holdIsOpen.bind(), blobsDue.bind(now, limit), backupsDue.bind(limit));
  return { held: hold[0]?.held === 1, blobs: blobs.map(row => ({ projectId: row.project_id, key: row.key })), backups: backups.map(row => row.id) };
}

const unregistered = read<[page: string], { p: string; k: string }>({ name: 'storage.unregisteredBlobs', sql:
  `SELECT c.p,c.k FROM ${PAGE} c WHERE NOT EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=c.p AND b.key=c.k)` });

/** The pairs among `pairs` no `blobs` row registers, each judged in its own Project. */
export async function unregisteredAmong(db: RelationalStore, pairs: readonly BlobRef[]): Promise<BlobRef[]> {
  const out: BlobRef[] = [];
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const [rows] = await readSet(db, unregistered.bind(pageOf(pairs.slice(at, at + RELEASE_PAGE))));
    out.push(...rows.map(row => ({ projectId: row.p, key: row.k })));
  }
  return out;
}

const referenceGuard = write<[page: string]>({ name: 'storage.registeredBlobsGuard', sql:
  `INSERT INTO restore_reference_guard(missing) SELECT c.k FROM ${PAGE} c WHERE NOT EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=c.p AND b.key=c.k)` });

/**
 * A statement that aborts its transaction when any pair names a blob no row registers. Placed first in the batch that
 * writes the rows naming them, it makes the registration check and those writes one transaction: a release that
 * commits first fails the batch, and one that commits after sees the new references and keeps the blob.
 */
export function registeredBlobsWrite(pairs: readonly BlobRef[]): Bound {
  return referenceGuard.bind(pageOf(pairs));
}

const EVIDENCE_CLOSED = `NOT EXISTS (
    SELECT 1 FROM registered_content_proofs p LEFT JOIN blobs b ON b.project_id=p.project_id AND b.key=p.key
    WHERE b.key IS NULL OR p.generation IS NOT b.generation OR p.size IS NOT b.size
  ) AND NOT EXISTS (
    SELECT 1 FROM raw_archive_refs r LEFT JOIN blobs b ON b.project_id=r.project_id AND b.key=r.source_blob_key
    WHERE r.disposition='hot' AND r.source_blob_key IS NOT NULL AND (b.key IS NULL OR r.source_generation IS NOT b.generation)
  )`;
const evidenceGuard = write<[]>({ name: 'storage.restoreEvidenceClosed', sql: `INSERT INTO storage_content_guard(ok) SELECT CASE WHEN ${EVIDENCE_CLOSED} THEN 1 ELSE 0 END` });
const evidenceGuardClear = write<[]>({ name: 'storage.restoreEvidenceClear', sql: 'DELETE FROM storage_content_guard' });
const renameCandidates = write<[generation: string]>({ name: 'storage.restoreCandidateGeneration', sql:
  `UPDATE blob_release_candidates SET generation=?1 WHERE EXISTS(SELECT 1 FROM blobs b
    WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key AND b.generation IS blob_release_candidates.generation)` });
const renameBlobs = write<[generation: string]>({ name: 'storage.restoreBlobGeneration', sql: 'UPDATE blobs SET generation=?' });
const renameProofs = write<[generation: string]>({ name: 'storage.restoreProofGeneration', sql: 'UPDATE registered_content_proofs SET generation=?' });
const renameRefs = write<[generation: string]>({ name: 'storage.restoreArchiveRefGeneration', sql:
  "UPDATE raw_archive_refs SET source_generation=? WHERE disposition='hot' AND source_blob_key IS NOT NULL" });

/** Names every registered blob and its content evidence under one fresh restore generation. */
export async function assignRestoreGeneration(db: RelationalStore, generation: string): Promise<void> {
  await commit(db, evidenceGuard.bind(), evidenceGuardClear.bind(), renameCandidates.bind(generation), renameBlobs.bind(generation), renameProofs.bind(generation),
    renameRefs.bind(generation), evidenceGuard.bind(), evidenceGuardClear.bind());
}
