/**
 * Archive bundles: the preparation a bundle's upload holds, the statements that publish a bundle and archive its source
 * rows in one transaction, and the reads that resolve a stored bundle.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { effectiveRawOwnerSql } from '../../core/raw-claims.js';
import { composedStatements } from '../composed-statements.js';
import { archivedEventPayloadSql } from '../document-tables.js';
import { commit, first, read, readSet, rows, write, type BindValue, type Bound } from '../index.js';
import { recordBlobCandidates } from './release-queue.js';
import { contentGuard } from './content-guard.js';

type Guard = { sql: string; params: readonly unknown[] };
type LiveGuard = { sql: string; params: () => readonly unknown[] };

const recordPreparation = write<[preparation: string, project: string, archive: string, expires: number]>({ name: 'archive.recordPreparation', sql:
  `INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,expires_at)
    VALUES(?1,?2,?3,?4)` });
/** Records the preparation an upload of bundle `archive` holds until `expires`. */
export async function recordArchivePreparation(db: RelationalStore, preparationId: string, projectId: string, archiveKey: string, expiresAt: number): Promise<void> {
  await commit(db, recordPreparation.bind(preparationId, projectId, archiveKey, expiresAt));
}

const stampReceipt = write<[receipt: string, expires: number, preparation: string, project: string, archive: string], { preparation_id: string }>({ name: 'archive.stampPreparationReceipt', sql:
  `UPDATE prepared_archive_bundles SET receipt_key=?1,expires_at=?2
      WHERE preparation_id=?3 AND project_id=?4 AND archive_key=?5 RETURNING preparation_id` });
/** Names the receipt on the preparation and extends it; false when the preparation is gone. */
export async function stampArchivePreparationReceipt(db: RelationalStore, preparation: { preparationId: string; projectId: string; archiveKey: string },
  receiptKey: string, expiresAt: number): Promise<boolean> {
  return (await rows(db, stampReceipt.bind(receiptKey, expiresAt, preparation.preparationId, preparation.projectId, preparation.archiveKey))).length === 1;
}

/** Holds while the preparation is live: what the bundle body's publication is guarded by. */
export const preparationLiveGuard = (preparationId: string, projectId: string, archiveKey: string): LiveGuard => ({
  sql: `EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND expires_at>?)`,
  params: () => [preparationId, projectId, archiveKey, Date.now()],
});

/** Holds while the preparation is live and names `receiptKey`: what the receipt's publication is guarded by. */
export const preparationReceiptGuard = (preparationId: string, projectId: string, archiveKey: string, receiptKey: string): LiveGuard => ({
  sql: `EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND receipt_key=? AND expires_at>?)`,
  params: () => [preparationId, projectId, archiveKey, receiptKey, Date.now()],
});

export interface BundlePublication {
  preparationId: string;
  projectId: string; sessionId: string; tokenId: string; eventId: string; envelopeHash: string;
  archiveKey: string; receiptKey: string; digest: string; size: number; version: number; entries: number;
  /** The body's and receipt's verified-content conditions. */
  body: Guard; receipt: Guard;
}

const insertBundle = write<[project: string, session: string, token: string, event: string, envelope: string, archive: string, receipt: string,
  digest: string, size: number, version: number, entries: number]>({ name: 'archive.insertBundle', sql:
  `INSERT INTO archive_bundles(project_id,session_id,token_id,event_id,envelope_hash,
      archive_key,receipt_key,digest,size,version,entry_count) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11
      ON CONFLICT(project_id,archive_key) DO NOTHING` });
const dropPreparation = write<[preparation: string, project: string, archive: string, receipt: string]>({ name: 'archive.adoptPreparation', sql:
  `DELETE FROM prepared_archive_bundles WHERE preparation_id=?1 AND project_id=?2 AND archive_key=?3 AND receipt_key=?4` });

/** Publication evidence and all source revisions are checked in the adopting transaction. */
function bundlePublication(bundle: BundlePublication): Bound<never, 'write'>[] {
  return [
    ...contentGuard(`EXISTS (SELECT 1 FROM prepared_archive_bundles
      WHERE preparation_id=? AND project_id=? AND archive_key=? AND receipt_key=? AND expires_at>?)`,
    [bundle.preparationId, bundle.projectId, bundle.archiveKey, bundle.receiptKey, Date.now()]),
    ...contentGuard(`${bundle.body.sql} AND ${bundle.receipt.sql} AND NOT EXISTS
      (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)`,
    [...bundle.body.params, ...bundle.receipt.params, bundle.projectId, bundle.sessionId]),
    insertBundle.bind(bundle.projectId, bundle.sessionId, bundle.tokenId, bundle.eventId, bundle.envelopeHash,
      bundle.archiveKey, bundle.receiptKey, bundle.digest, bundle.size, bundle.version, bundle.entries),
    ...contentGuard(`EXISTS (SELECT 1 FROM archive_bundles WHERE project_id=? AND archive_key=? AND receipt_key=?
      AND session_id=? AND token_id=? AND digest=? AND size=? AND entry_count=?)`,
    [bundle.projectId, bundle.archiveKey, bundle.receiptKey, bundle.sessionId, bundle.tokenId, bundle.digest, bundle.size, bundle.entries]),
    dropPreparation.bind(bundle.preparationId, bundle.projectId, bundle.archiveKey, bundle.receiptKey),
  ];
}

const SOURCES_UNCHANGED = `NOT EXISTS (SELECT 1 FROM json_each(?) j
    LEFT JOIN events e ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.event_id')
    LEFT JOIN raw_credentials c ON c.token_id=json_extract(j.value,'$.token_id')

    WHERE e.event_id IS NULL OR e.session_id<>json_extract(j.value,'$.session_id')
      OR e.envelope_hash<>json_extract(j.value,'$.envelope_hash') OR (json_extract(j.value,'$.kind')='event' AND e.token_id<>json_extract(j.value,'$.token_id'))
      OR COALESCE(e.raw_revision,0)<>COALESCE(json_extract(j.value,'$.raw_revision'),0)
      OR (json_type(j.value,'$.raw_owner') IS NOT NULL AND ${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
        IS NOT json_extract(j.value,'$.raw_owner'))
      OR (json_type(j.value,'$.raw_provenance') IS NOT NULL AND c.provenance IS NOT json_extract(j.value,'$.raw_provenance'))
      OR e.payload_format<>'inline' OR e.content_revision<>json_extract(j.value,'$.content_revision')
        OR length(CAST(e.payload AS BLOB))<>json_extract(j.value,'$.bytes'))`;

const locatorValue = (field: string) => `(SELECT json_extract(j.value,'$.${field}') FROM json_each(?) j
      WHERE json_extract(j.value,'$.kind')='event' AND json_extract(j.value,'$.project')=events.project_id
        AND json_extract(j.value,'$.id')=events.event_id)`;
const archiveEvents = write<[project: string, archive: string, locators: string]>({ name: 'archive.archiveEvents', sql:
  `UPDATE events SET
      archived_ended_at=COALESCE(CASE WHEN json_valid(payload) THEN json_extract(payload,'$.endedAt') END,created_at),
      archived_title_only_end=CASE WHEN kind='session.end' AND json_valid(payload) AND json_type(payload,'$.endedAt') IS NULL
        AND json_type(payload,'$.title') IS NOT NULL THEN 1 ELSE 0 END,
      archived_prompt_origin=CASE WHEN json_valid(payload) THEN json_extract(payload,'$.origin') END,
      bundle_id=(SELECT id FROM archive_bundles WHERE project_id=?1 AND archive_key=?2),bundle_entry=${locatorValue('entry').replace('json_each(?)', 'json_each(?3)')},
      payload=${archivedEventPayloadSql()},payload_format='archived',payload_bytes=0 WHERE rowid IN (SELECT r.rowid FROM json_each(?3) j CROSS JOIN events r
      WHERE json_extract(j.value,'$.kind')='event' AND r.project_id=json_extract(j.value,'$.project')
        AND r.event_id=json_extract(j.value,'$.id'))` });
const clearCheckpoints = write<[sources: string]>({ name: 'archive.clearScanCheckpoints', sql:
  `DELETE FROM content_scan_checkpoints WHERE rowid IN
    (SELECT c.rowid FROM json_each(?) j CROSS JOIN content_scan_checkpoints c
      WHERE c.project_id=json_extract(j.value,'$.project_id')
        AND c.source_kind=json_extract(j.value,'$.kind')
        AND c.resource_id=json_extract(j.value,'$.resource_id')
        AND c.content_revision=json_extract(j.value,'$.content_revision')
        AND c.envelope_hash=json_extract(j.value,'$.envelope_hash'))` });
const clearOmissions = write<[sources: string]>({ name: 'archive.clearCleanupOmissions', sql:
  `DELETE FROM storage_cleanup_omissions WHERE rowid IN
    (SELECT o.rowid FROM json_each(?) j CROSS JOIN storage_cleanup_omissions o
      WHERE o.project_id=json_extract(j.value,'$.project_id') AND o.resource_kind=json_extract(j.value,'$.kind')
        AND o.resource_id=json_extract(j.value,'$.resource_id'))` });

/**
 * Publish the bundle and move each source event onto its compact locator, in the caller's transaction: the sources must
 * still be the revisions the bundle read. `sources` lists each source row with its kind; `locators` each entry.
 */
export function bundleArchive(bundle: BundlePublication, sources: string, locators: string): Bound<never, 'write'>[] {
  return [
    ...contentGuard(SOURCES_UNCHANGED, [sources]),
    ...bundlePublication(bundle),
    archiveEvents.bind(bundle.projectId, bundle.archiveKey, locators),
    clearCheckpoints.bind(sources),
    clearOmissions.bind(sources),
  ];
}

export interface StoredBundle {
  project_id: string; session_id: string; token_id: string; event_id: string; envelope_hash: string;
  archive_key: string; receipt_key: string; digest: string; size: number; version: number; entry_count: number;
  id: number; generation: string | null; receipt_generation: string | null; receipt_size: number;
}
const storedBundle = read<[project: string, bundle: number], StoredBundle>({ name: 'archive.storedBundle', sql:
  `SELECT a.*,b.generation,rb.generation AS receipt_generation,rb.size AS receipt_size
    FROM archive_bundles a JOIN blobs b ON b.project_id=a.project_id AND b.key=a.archive_key AND b.size=a.size
    JOIN blobs rb ON rb.project_id=a.project_id AND rb.key=a.receipt_key WHERE a.project_id=?1 AND a.id=?2` });
/** A stored bundle with the registrations of its body and receipt, or null. */
export const readStoredBundle = (db: RelationalStore, projectId: string, bundleId: number): Promise<StoredBundle | null> =>
  first(db, storedBundle.bind(projectId, bundleId));

const proofHeld = composedStatements<{ ok: number }, 'read'>('archive.proofHeld');
/** Whether the verified-content condition `proof` holds now. */
export async function contentProofHeld(db: RelationalStore, proof: Guard): Promise<boolean> {
  const sql = `SELECT 1 AS ok WHERE ${proof.sql}`;
  return (await first(db, proofHeld(sql, name => read<BindValue[], { ok: number }>({ name, sql })).bind(...(proof.params as BindValue[])))) !== null;
}

/** Holds while the bundle row still states what was read of it: part of the evidence a reader of its entries carries. */
export const storedBundleEvidence = (projectId: string, bundleId: number, row: StoredBundle): Guard => ({
  sql: `EXISTS(SELECT 1 FROM archive_bundles WHERE project_id=? AND id=? AND archive_key=? AND receipt_key=?
    AND session_id=? AND token_id=? AND event_id=? AND envelope_hash=? AND digest=? AND size=? AND version=? AND entry_count=?)`,
  params: [projectId, bundleId, row.archive_key, row.receipt_key, row.session_id, row.token_id, row.event_id, row.envelope_hash, row.digest, row.size, row.version, row.entry_count],
});

const registration = read<[project: string, key: string], { generation: string | null; size: number }>({ name: 'archive.blobRegistration', sql:
  'SELECT generation,size FROM blobs WHERE project_id=?1 AND key=?2' });
/** The registrations of a bundle's body and receipt, in one read; undefined where one is not registered. */
export async function bundleRegistrations(db: RelationalStore, projectId: string, archiveKey: string, receiptKey: string) {
  const [[body], [receipt]] = await readSet(db, registration.bind(projectId, archiveKey), registration.bind(projectId, receiptKey));
  return { body, receipt };
}

export type PreparationRecord = { preparation_id: string; project_id: string; archive_key: string; receipt_key: string | null; expires_at: number };
const preparation = read<[preparation: string], PreparationRecord>({ name: 'archive.preparation', sql:
  `SELECT preparation_id,project_id,archive_key,receipt_key,expires_at
    FROM prepared_archive_bundles WHERE preparation_id=?1` });
export const readArchivePreparation = (db: RelationalStore, preparationId: string): Promise<PreparationRecord | null> => first(db, preparation.bind(preparationId));

/** The preparation as read, and, for an aged release, still aged at `now`: every statement of its release holds it. */
const current = (aged: boolean, slot: (n: number) => string) => `EXISTS (SELECT 1 FROM prepared_archive_bundles p
    WHERE p.preparation_id=${slot(1)} AND p.project_id=${slot(2)} AND p.archive_key=${slot(3)} AND p.receipt_key IS ${slot(4)}
      AND p.expires_at=${slot(5)}${aged ? ` AND p.expires_at<=${slot(6)}` : ''})`;
type ReleaseParams = [preparation: string, project: string, archive: string, receipt: string | null, expires: number, ...aged: number[]];
const releaseStatements = (aged: boolean) => {
  const suffix = aged ? 'Aged' : '';
  const at = (n: number) => `?${n}`;
  return {
    bundleProofs: write<ReleaseParams>({ name: `archive.releaseBundleProofs${suffix}`, sql:
      `DELETE FROM registered_content_proofs WHERE project_id=?2 AND source_kind='bundle'
      AND source_id=?3 AND key=?3 AND NOT EXISTS
        (SELECT 1 FROM archive_bundles WHERE project_id=?2 AND archive_key=?3)
      AND NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=?2 AND archive_key=?3 AND preparation_id<>?1) AND ${current(aged, at)}` }),
    receiptProofs: write<[...ReleaseParams, receiptSource: string]>({ name: `archive.releaseReceiptProofs${suffix}`, sql:
      `DELETE FROM registered_content_proofs
      WHERE project_id=?2 AND source_kind='receipt' AND source_id=?${aged ? 7 : 6} AND key=?4 AND NOT EXISTS
        (SELECT 1 FROM archive_bundles WHERE project_id=?2 AND receipt_key=?4)
      AND NOT EXISTS (SELECT 1 FROM prepared_archive_bundles
        WHERE project_id=?2 AND receipt_key=?4 AND preparation_id<>?1) AND ${current(aged, at)}` }),
    preparation: write<ReleaseParams, { preparation_id: string }>({ name: `archive.releasePreparation${suffix}`, sql:
      `DELETE FROM prepared_archive_bundles WHERE preparation_id=?1 AND project_id=?2
      AND archive_key=?3 AND receipt_key IS ?4 AND expires_at=?5 ${aged ? 'AND expires_at<=?6' : ''} RETURNING preparation_id` }),
  };
};
const RELEASES = { fresh: releaseStatements(false), aged: releaseStatements(true) };

/**
 * Release one preparation's publication evidence while it is exactly as read, recording the blobs it named as release
 * candidates in the same transaction; the preparation's own row goes last. False when the preparation moved.
 */
export async function releaseArchivePreparationRows(db: RelationalStore, row: PreparationRecord, now: number, { agedOnly }: { agedOnly: boolean }): Promise<boolean> {
  const pairs = [row.archive_key, row.receipt_key].filter((key): key is string => key !== null).map(key => ({ projectId: row.project_id, key }));
  const statements = agedOnly ? RELEASES.aged : RELEASES.fresh;
  const params: ReleaseParams = [row.preparation_id, row.project_id, row.archive_key, row.receipt_key, row.expires_at, ...(agedOnly ? [now] : [])];
  const results = await commit(db,
    ...recordBlobCandidates(pairs, now, { preparationId: row.preparation_id, projectId: row.project_id, archiveKey: row.archive_key,
      receiptKey: row.receipt_key, expiresAt: row.expires_at, agedAt: agedOnly ? now : null }),
    statements.bundleProofs.bind(...params),
    ...(row.receipt_key === null ? [] : [statements.receiptProofs.bind(...params, `bundle:${row.archive_key}`)]),
    statements.preparation.bind(...params));
  return (results.at(-1)?.results.length ?? 0) === 1;
}

const agedPage = read<[now: number, limit: number], { preparation_id: string }>({ name: 'archive.agedPreparations', sql:
  `SELECT preparation_id FROM prepared_archive_bundles
    WHERE expires_at<=?1 ORDER BY expires_at,preparation_id LIMIT ?2` });
/** One age-ordered page of preparations past their expiry. */
export const agedArchivePreparations = async (db: RelationalStore, now: number, limit: number): Promise<string[]> =>
  (await rows(db, agedPage.bind(now, limit))).map(row => row.preparation_id);
