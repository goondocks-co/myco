import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { blobObjectKeySql } from '../../core/blob-objects.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import type { BlobRef } from '../../core/blob-references.js';
import { commit, read, readSet, write } from '../index.js';
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
export interface PreparationGuard {
  preparationId: string; projectId: string; archiveKey: string; receiptKey: string | null; expiresAt: number; agedAt: number | null;
}

/**
 * What must still stand when a candidate is recorded, so a caller holding an earlier read cannot observe a registration
 * made after its reference went: the preparation or the bundle whose rows named the blob. `callerHoldsReference` is for a
 * caller whose own transaction proves it. A caller that read the references itself records through `recordObservedCandidates`.
 */
export type CandidateGuard = PreparationGuard | { bundle: { projectId: string; bundleId: number } } | { callerHoldsReference: true };

/** A registration an aged orphan sweep read: the generation it saw, and nothing newer. */
export interface ObservedOrphan extends BlobRef { generation: string | null }

const pageOf = (pairs: readonly BlobRef[]): string => JSON.stringify(pairs.map(b => ({ p: b.projectId, k: b.key })));
const PAGE = `(SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k FROM json_each(?1) j)`;
const physical = (alias: string) => blobObjectKeySql(`${alias}.project_id`, `${alias}.key`, `${alias}.generation`);
/** The candidate authorizes only the registration it observed; a `'*'` candidate observed none until its blob has aged past the orphan grace. */
const candidate = (alias: string) => `EXISTS(SELECT 1 FROM blob_release_candidates rc WHERE rc.project_id=${alias}.project_id AND rc.key=${alias}.key
  AND ${alias}.generation IS rc.generation)`;
const OBSERVED = `(SELECT b.generation FROM blobs b WHERE b.project_id=c.p AND b.key=c.k)`;
const REOBSERVE = 'ON CONFLICT(project_id,key) DO UPDATE SET generation=excluded.generation';

const record = write<[page: string, now: number]>({ name: 'storage.recordBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT c.p,c.k,?2,${OBSERVED} FROM ${PAGE} c WHERE c.k IS NOT NULL
    ${REOBSERVE}` });
const recordForPreparation = write<[page: string, now: number, preparation: string, project: string, archive: string, receipt: string | null, expires: number, aged: number | null]>({
  name: 'storage.recordPreparationBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT c.p,c.k,?2,${OBSERVED} FROM ${PAGE} c WHERE c.k IS NOT NULL
    AND EXISTS(SELECT 1 FROM prepared_archive_bundles pb WHERE pb.preparation_id=?3 AND pb.project_id=?4 AND pb.archive_key=?5
      AND pb.receipt_key IS ?6 AND pb.expires_at=?7 AND (?8 IS NULL OR pb.expires_at<=?8))
    ${REOBSERVE}` });
const recordObserved = write<[page: string, now: number]>({ name: 'storage.recordObservedBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
    SELECT b.project_id,b.key,?2,b.generation FROM (SELECT json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k,json_extract(j.value,'$.g') AS g FROM json_each(?1) j) c
    JOIN blobs b ON b.project_id=c.p AND b.key=c.k WHERE b.generation IS c.g
    ${REOBSERVE}` });
const recordForBundle = write<[page: string, now: number, project: string, bundle: number]>({ name: 'storage.recordBundleBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation) SELECT c.p,c.k,?2,${OBSERVED} FROM ${PAGE} c WHERE c.k IS NOT NULL
    AND EXISTS(SELECT 1 FROM archive_bundles a WHERE a.project_id=?3 AND a.id=?4)
    ${REOBSERVE}` });
const recordForHolders = write<[page: string, now: number]>({ name: 'storage.recordHolderBlobCandidates', sql:
  `INSERT INTO blob_release_candidates(project_id,key,created_at,generation)
    SELECT r.project_id,r.blob_key,?2,b.generation FROM json_each(?1) j
      JOIN retired_objects r ON r.project_id=json_extract(j.value,'$.p') AND r.session_id=json_extract(j.value,'$.s')
        AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i')
      JOIN blobs b ON b.project_id=r.project_id AND b.key=r.blob_key WHERE true
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
const clearDecided = write<[page: string], { key: string }>({ name: 'storage.clearDecidedBlobCandidates', sql:
  `DELETE FROM blob_release_candidates WHERE NOT ${HOLD_OPEN} AND (project_id,key) IN (SELECT c.p,c.k FROM ${PAGE} c)
    AND NOT (generation IS '*' AND EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=blob_release_candidates.project_id AND b.key=blob_release_candidates.key)) RETURNING key` });
const heldCandidates = read<[page: string], { held: number }>({ name: 'storage.heldBlobCandidates', sql:
  `SELECT COUNT(*) AS held FROM blob_release_candidates rc WHERE (rc.project_id,rc.key) IN (SELECT c.p,c.k FROM ${PAGE} c)` });

const decision = (page: string, now: number) => [observeAgedLegacy.bind(page, now - BLOB_RESERVATION_TTL_MS), journalUnreferenced.bind(page, now), removeJournaled.bind(page), clearDecided.bind(page), heldCandidates.bind(page)] as const;

/**
 * Statements that record `pairs` as blob release candidates, one per page, placed ahead of the statements that remove the
 * rows naming them. Each candidate holds the generation registered as that batch commits, and is recorded only while
 * `guard` stands, so a stale caller records nothing. Recorded in that same transaction, a candidate outlives any
 * interruption before it is decided: the drain decides what a caller did not.
 */
export function recordBlobCandidates(db: RelationalStore, pairs: readonly BlobRef[], now: number, guard: CandidateGuard): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (let at = 0; at < pairs.length; at += RELEASE_PAGE) {
    const page = pageOf(pairs.slice(at, at + RELEASE_PAGE));
    statements.push(prepareBound(db, 'preparationId' in guard ? recordForPreparation.bind(page, now, guard.preparationId, guard.projectId, guard.archiveKey, guard.receiptKey, guard.expiresAt, guard.agedAt)
      : 'bundle' in guard ? recordForBundle.bind(page, now, guard.bundle.projectId, guard.bundle.bundleId)
        : record.bind(page, now)));
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
export interface HolderRef { p: string; s: string; k: string; i: string }

/** Statements that record the blobs of those holders that still stand, ahead of the statement removing them. */
export function recordHolderCandidates(db: RelationalStore, holders: readonly HolderRef[], now: number): PreparedStatement[] {
  const statements: PreparedStatement[] = [];
  for (let at = 0; at < holders.length; at += RELEASE_PAGE) statements.push(prepareBound(db, recordForHolders.bind(JSON.stringify(holders.slice(at, at + RELEASE_PAGE)), now)));
  return statements;
}

export interface BlobDecision extends ReleaseOutcome {
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
  const [, , removed, cleared, held] = await commit(db, ...decision(page, now));
  return { released: removed.results.length, deferred: held.results[0]!.held, decided: cleared.results.length };
}

/**
 * Releases orphans an earlier read found aged and unreferenced. Each is recorded only while the row still holds the
 * generation read and is at or past `cutoff`, in the commit that decides it; a hold keeps that candidate for later.
 */
export async function releaseAgedOrphans(db: RelationalStore, observed: readonly ObservedOrphan[], now: number, cutoff: number): Promise<ReleaseOutcome> {
  const outcome: ReleaseOutcome = { released: 0, deferred: 0 };
  for (let at = 0; at < observed.length; at += RELEASE_PAGE) {
    const page = JSON.stringify(observed.slice(at, at + RELEASE_PAGE).map(b => ({ p: b.projectId, k: b.key, g: b.generation })));
    const [, , , removed, , held] = await commit(db, recordAgedOrphans.bind(page, now, cutoff), ...decision(page, now));
    outcome.released += removed.results.length;
    outcome.deferred += held.results[0]!.held;
  }
  return outcome;
}

const holdIsOpen = read<[], { held: number }>({ name: 'storage.releaseHoldOpen', sql: `SELECT ${HOLD_OPEN} AS held` });
const blobsDue = read<[limit: number], { project_id: string; key: string }>({ name: 'storage.blobCandidatesDue', sql:
  'SELECT project_id,key FROM blob_release_candidates ORDER BY created_at,project_id,key LIMIT ?' });
const backupsDue = read<[limit: number], { id: string }>({ name: 'storage.backupCandidatesDue', sql:
  'SELECT id FROM backup_release_candidates ORDER BY created_at,id LIMIT ?' });

/** The next candidates of each ordered queue; `held` while a recovery hold keeps every one of them recorded. */
export async function releaseCandidatesDue(db: RelationalStore, limit: number): Promise<{ held: boolean; blobs: BlobRef[]; backups: string[] }> {
  const [hold, blobs, backups] = await readSet(db, holdIsOpen.bind(), blobsDue.bind(limit), backupsDue.bind(limit));
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
export function registeredBlobsGuard(db: RelationalStore, pairs: readonly BlobRef[]): PreparedStatement {
  return prepareBound(db, referenceGuard.bind(pageOf(pairs)));
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
