/**
 * A document commit's chunk versions: held by `retired_objects` rows from before they are registered, adopted into the
 * directory by the commit that removes those rows, and their pages and sealed records catalogued beside them.
 */
import { write, type Bound } from '../index.js';
import { namedContentGuard } from '../storage/content-guard.js';
import { recordHolderCandidates, registeredBlobsWrite } from '../storage/release-queue.js';
import type { DocumentKey } from './turn-statistics.js';
import type { Holder } from './retired-holders.js';

const hold = write<[now: number, holders: string]>({ name: 'documentChunks.holdVersions', sql: `INSERT INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
  SELECT json_extract(value,'$.p'),json_extract(value,'$.s'),json_extract(value,'$.k'),json_extract(value,'$.i'),?1 FROM json_each(?2)` });
const dropProofs = write<[holders: string]>({ name: 'documentChunks.dropHolderProofs', sql: `DELETE FROM registered_content_proofs WHERE source_kind='document' AND (project_id,key,source_id) IN
  (SELECT r.project_id,r.blob_key,r.source_id FROM json_each(?1) j JOIN retired_objects r ON r.project_id=json_extract(j.value,'$.p')
    AND r.session_id=json_extract(j.value,'$.s') AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i')
   WHERE NOT EXISTS (SELECT 1 FROM session_chunks c WHERE c.project_id=r.project_id AND c.blob_key=r.blob_key AND c.source_id=r.source_id))` });
const dropHolders = write<[holders: string]>({ name: 'documentChunks.dropHolders', sql: `DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
  (SELECT json_extract(value,'$.p'),json_extract(value,'$.s'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?1))` });

/** Holds each version by a `retired_objects` row before it is registered. */
export const holdVersionsWrite = (now: number, holders: readonly Holder[]): Bound => hold.bind(now, JSON.stringify(holders));

/**
 * Records the blobs of the holders that still stand, then deletes those holders, each with the proofs registered under
 * its own source unless a live chunk names that source.
 */
export function releaseHolderWrites(holders: readonly Holder[], now: number): Bound[] {
  const page = JSON.stringify(holders);
  return [...recordHolderCandidates(holders, now), dropProofs.bind(page), dropHolders.bind(page)];
}

const versionsHeld = namedContentGuard<[versions: string, project: string, session: string, count: number]>('documentChunks.versionsHeld',
  `(SELECT COUNT(*) FROM json_each(?1) j JOIN retired_objects r ON r.project_id=?2 AND r.session_id=?3
    AND r.blob_key=json_extract(j.value,'$.k') AND r.source_id=json_extract(j.value,'$.i'))=?4`);
const adoptHolders = write<[project: string, session: string, versions: string]>({ name: 'documentChunks.adoptHolders', sql: `DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
  (SELECT ?1,?2,json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?3))` });
const retireReplaced = write<[now: number, versions: string, ...DocumentKey]>({ name: 'documentChunks.retireReplaced', sql: `INSERT OR IGNORE INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
  SELECT c.project_id,c.session_id,c.blob_key,c.source_id,?1 FROM json_each(?2) j JOIN session_chunks c
    ON c.project_id=?3 AND c.session_id=?4 AND c.generation=?5 AND c.chunk_no=json_extract(j.value,'$.n')` });
const saveChunks = write<[...DocumentKey, state: string, versions: string]>({ name: 'documentChunks.saveChunks', sql: `INSERT INTO session_chunks (project_id,session_id,generation,chunk_no,blob_key,kind,encoding,bytes,source_id,state,metadata)
  SELECT ?1,?2,?3,json_extract(value,'$.n'),json_extract(value,'$.k'),json_extract(value,'$.d'),json_extract(value,'$.e'),
    json_extract(value,'$.b'),json_extract(value,'$.i'),?4,json_extract(value,'$.m') FROM json_each(?5) WHERE true
  ON CONFLICT (project_id,session_id,generation,chunk_no) DO UPDATE SET blob_key=excluded.blob_key,kind=excluded.kind,
    encoding=excluded.encoding,bytes=excluded.bytes,source_id=excluded.source_id,state=excluded.state,metadata=excluded.metadata` });

/** The commit fails unless every version it adopts is still held for this session. */
export const versionsHeldGuard = (versions: string, project: string, session: string, count: number): Bound[] => versionsHeld(versions, project, session, count);

/**
 * Adopts registered versions into the directory: every blob is still registered, the versions' holders go, the chunks
 * they replace are held in turn, and the directory names the new versions.
 */
export function adoptVersionWrites(key: DocumentKey, blobs: readonly { projectId: string; key: string }[], versions: string, state: string, now: number): Bound[] {
  const [project, session] = key;
  return [registeredBlobsWrite(blobs), adoptHolders.bind(project, session, versions), retireReplaced.bind(now, versions, ...key), saveChunks.bind(...key, state, versions)];
}

const savePages = write<[...DocumentKey, pages: string]>({ name: 'documentChunks.savePages', sql: `INSERT INTO session_pages (project_id,session_id,generation,owner,page,chunk_no,records,bytes)
  SELECT ?1,?2,?3,json_extract(value,'$.owner'),json_extract(value,'$.page'),json_extract(value,'$.chunkNo'),
    json_extract(value,'$.records'),json_extract(value,'$.bytes') FROM json_each(?4) WHERE true
  ON CONFLICT (project_id,session_id,generation,owner,page) DO UPDATE SET chunk_no=excluded.chunk_no,records=excluded.records,bytes=excluded.bytes` });
const saveSealed = write<[...DocumentKey, records: string]>({ name: 'documentChunks.saveSealedRecords', sql: `INSERT INTO session_sealed_records (project_id,session_id,generation,owner,k,record_id,page)
  SELECT ?1,?2,?3,json_extract(value,'$.o'),json_extract(value,'$.k'),json_extract(value,'$.i'),json_extract(value,'$.p') FROM json_each(?4) WHERE true
  ON CONFLICT (project_id,session_id,generation,owner,k,record_id) DO UPDATE SET page=excluded.page` });
const sealPages = write<[...DocumentKey, pages: string]>({ name: 'documentChunks.sealPages', sql: `UPDATE session_pages SET sealed=1 WHERE project_id=?1 AND session_id=?2 AND generation=?3
  AND (owner,page) IN (SELECT json_extract(value,'$.o'),json_extract(value,'$.p') FROM json_each(?4))` });
const dropSealed = write<[...DocumentKey, records: string]>({ name: 'documentChunks.dropSealedRecords', sql: `DELETE FROM session_sealed_records WHERE project_id=?1 AND session_id=?2 AND generation=?3
  AND (owner,k,record_id) IN (SELECT json_extract(value,'$.o'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?4))` });

export const savePagesWrite = (key: DocumentKey, pages: string): Bound => savePages.bind(...key, pages);
export const saveSealedRecordsWrite = (key: DocumentKey, records: string): Bound => saveSealed.bind(...key, records);
export const sealPagesWrite = (key: DocumentKey, pages: string): Bound => sealPages.bind(...key, pages);
export const dropSealedRecordsWrite = (key: DocumentKey, records: string): Bound => dropSealed.bind(...key, records);
