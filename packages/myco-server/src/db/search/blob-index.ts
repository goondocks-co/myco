import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';
import type { ProjectSet } from '../../read/scope.js';
import { assertion, commit, read, readSet, refusalCode, refused, write, type Bound } from '../index.js';
import { SEARCH_BLOB_WORK } from './blob-index-schema.js';
import { allocateDocId, SEARCH_DOCUMENTS_PROJECTION } from './documents-schema.js';

/**
 * The search indexer's work on stored plan bodies. A pass takes the soonest due blob that is not `indexed`: a waiting
 * blob is claimed, read from its recorded byte, and its chunks committed with its next byte while the claim, generation
 * and a live reference still hold; a leaving blob loses a bounded page of chunk documents per pass, and its row goes
 * only once none remain and it is still leaving under the same generation.
 */
const CLAIM_LOST = refusalCode('search_index_claim_lost');
const RETIREMENT_MOVED = refusalCode('search_index_retirement_moved');

export interface DueBlob {
  project_id: string; blob_key: string; state: 'pending' | 'retiring'; generation: number; claim: number; next_byte: number;
  object_key: string | null; received_at: number | null;
  /** The blob's registered size in bytes. */
  size: number | null;
}

const due = read<[now: number], DueBlob>({ name: 'searchIndex.due', sql:
  `SELECT b.project_id, b.blob_key, b.state, b.generation, b.claim, b.next_byte, ${registeredObjectKeySql('b.project_id', 'b.blob_key')} AS object_key,
    (SELECT received_at FROM blobs WHERE project_id = b.project_id AND key = b.blob_key) AS received_at,
    (SELECT size FROM blobs WHERE project_id = b.project_id AND key = b.blob_key) AS size
  FROM search_blobs b WHERE b.${SEARCH_BLOB_WORK} AND b.due_at <= ?1 ORDER BY b.due_at, b.project_id, b.blob_key LIMIT 1` });

/** The soonest blob due for a pass, or null when none is due. */
export async function dueSearchBlob(db: RelationalStore, now: number): Promise<DueBlob | null> {
  const [rows] = await readSet(db, due.bind(now));
  return rows[0] ?? null;
}

/**
 * A claim holds the blob for one pass until `leaseUntil`, so a pass running beside it does not take it over; a pass
 * that never commits leaves the blob due again when its lease ends, and a later claim makes the earlier pass's commit refuse.
 */
const claim = write<[leaseUntil: number, project: string, blob: string, generation: number, claim: number, nextByte: number, now: number], { claim: number }>({ name: 'searchIndex.claim', sql:
  `UPDATE search_blobs SET claim = claim + 1, due_at = ?1
    WHERE project_id = ?2 AND blob_key = ?3 AND generation = ?4 AND claim = ?5 AND next_byte = ?6 AND state = 'pending' AND due_at <= ?7 RETURNING claim` });

/** Claims a waiting blob for one pass until `leaseUntil`; null when another pass or a reference change moved it first. */
export async function claimSearchBlob(db: RelationalStore, blob: DueBlob, now: number, leaseUntil: number): Promise<number | null> {
  const [claimed] = await commit(db, claim.bind(leaseUntil, blob.project_id, blob.blob_key, blob.generation, blob.claim, blob.next_byte, now));
  return claimed.results[0]?.claim ?? null;
}

const held = assertion<[project: string, blob: string, generation: number, claim: number, nextByte: number]>({ name: 'searchIndex.held', refusal: CLAIM_LOST,
  when: `EXISTS (SELECT 1 FROM search_blobs WHERE project_id = ?1 AND blob_key = ?2 AND generation = ?3 AND claim = ?4 AND next_byte = ?5
    AND state = 'pending' AND live_refs > 0)` });
const chunkKey = `project_id = ?1 AND kind = 'chunk' AND source_key = json_array(?2, CAST(?3 AS INTEGER))`;
const chunkOut = write<[project: string, blob: string, offset: number]>({ name: 'searchIndex.chunkOut', sql: `DELETE FROM search_documents WHERE ${chunkKey}` });
const chunkIn = write<[project: string, blob: string, offset: number, ms: number, facets: string, text: string]>({ name: 'searchIndex.chunkIn',
  sql: `INSERT INTO search_documents(doc_id, project_id, kind, source_key, session_id, blob_key, record_at, facets, headline, body)
    VALUES (${allocateDocId('?4', '0')}, ?1, 'chunk', json_array(?2, CAST(?3 AS INTEGER)), NULL, ?2, CAST(?4 AS INTEGER), ?5, NULL, ?6)` });
const advance = write<[nextByte: number, state: string, project: string, blob: string, generation: number, claim: number], { state: string }>({ name: 'searchIndex.advance',
  sql: `UPDATE search_blobs SET next_byte = ?1, state = ?2, due_at = 0, failures = 0, failure = NULL
    WHERE project_id = ?3 AND blob_key = ?4 AND generation = ?5 AND claim = ?6 RETURNING state` });

export interface IndexedChunk { byteOffset: number; text: string }

/**
 * Writes a pass's chunks as documents and moves the blob's next byte past them, in one batch, only while the pass's
 * claim, the blob's generation and a live reference still hold. Answers the chunks written, or null when the pass lost
 * its blob and wrote nothing.
 */
export async function commitSearchChunks(db: RelationalStore, blob: DueBlob, claimed: number, options: {
  chunks: readonly IndexedChunk[]; nextByte: number; complete: boolean; recordAt: number; facets: string;
}): Promise<number | null> {
  const writes: Bound[] = options.chunks.flatMap((chunk) => [
    chunkOut.bind(blob.project_id, blob.blob_key, chunk.byteOffset),
    chunkIn.bind(blob.project_id, blob.blob_key, chunk.byteOffset, options.recordAt, options.facets, chunk.text),
  ]);
  try {
    await commit(db, held.bind(blob.project_id, blob.blob_key, blob.generation, claimed, blob.next_byte), ...writes,
      advance.bind(options.nextByte, options.complete ? 'indexed' : 'pending', blob.project_id, blob.blob_key, blob.generation, claimed));
    return options.chunks.length;
  } catch (error) {
    if (refused(error, CLAIM_LOST)) return null;
    throw error;
  }
}

const failed = write<[failure: string, dueAt: number, project: string, blob: string, generation: number, claim: number]>({ name: 'searchIndex.failed',
  sql: 'UPDATE search_blobs SET failures = failures + 1, failure = ?1, due_at = ?2 WHERE project_id = ?3 AND blob_key = ?4 AND generation = ?5 AND claim = ?6' });

/** Records a failed pass on the blob it claimed, due again at `dueAt`; the blob stays waiting and counted. */
export async function failSearchBlob(db: RelationalStore, blob: DueBlob, claimed: number, failure: string, dueAt: number): Promise<void> {
  await commit(db, failed.bind(failure, dueAt, blob.project_id, blob.blob_key, blob.generation, claimed));
}

const leaving = assertion<[project: string, blob: string, generation: number]>({ name: 'searchIndex.leaving', refusal: RETIREMENT_MOVED,
  when: `EXISTS (SELECT 1 FROM search_blobs WHERE project_id = ?1 AND blob_key = ?2 AND state = 'retiring' AND generation = ?3)` });
const blobChunks = `SELECT doc_id FROM search_documents WHERE project_id = ?1 AND blob_key = ?2 AND kind = 'chunk' ORDER BY doc_id LIMIT ?3`;
const retireDocuments = write<[project: string, blob: string, limit: number], { doc_id: number }>({ name: 'searchIndex.retireDocuments', sql: `DELETE FROM search_documents WHERE doc_id IN (${blobChunks}) RETURNING doc_id` });
const retired = write<[project: string, blob: string, generation: number], { blob_key: string }>({ name: 'searchIndex.retired',
  sql: `DELETE FROM search_blobs WHERE project_id = ?1 AND blob_key = ?2 AND state = 'retiring' AND generation = ?3 AND live_refs = 0
    AND NOT EXISTS (SELECT 1 FROM search_documents WHERE project_id = ?1 AND blob_key = ?2 AND kind = 'chunk') RETURNING blob_key` });

/**
 * Removes up to `limit` of a leaving blob's chunk documents, and the blob's row once none remain, in one batch that
 * holds only while the blob is still leaving under the generation read. Answers the documents removed (0 when a
 * returning reference moved the blob first) and whether the blob's row went.
 */
export async function retireSearchChunks(db: RelationalStore, blob: DueBlob, limit: number): Promise<{ removed: number; done: boolean }> {
  try {
    const results = await commit(db, leaving.bind(blob.project_id, blob.blob_key, blob.generation),
      retireDocuments.bind(blob.project_id, blob.blob_key, limit), retired.bind(blob.project_id, blob.blob_key, blob.generation));
    return { removed: results[1].results.length, done: results[2].results.length > 0 };
  } catch (error) {
    if (refused(error, RETIREMENT_MOVED)) return { removed: 0, done: false };
    throw error;
  }
}

const anyDue = read<[now: number], { found: number }>({ name: 'searchIndex.anyDue',
  sql: `SELECT 1 AS found FROM search_blobs WHERE ${SEARCH_BLOB_WORK} AND due_at <= ?1 LIMIT 1` });

/** Whether any blob is due for a pass now. */
export async function searchBlobsDue(db: RelationalStore, now: number): Promise<boolean> {
  const [rows] = await readSet(db, anyDue.bind(now));
  return rows.length > 0;
}

const READY = read<[], { done: number }>({ name: 'searchIndex.ready',
  sql: `SELECT done FROM projection_catchup WHERE projection = '${SEARCH_DOCUMENTS_PROJECTION}' AND phase = 'searchBlobRefs'` });
const PENDING = {
  project: read<[project: string], { pending: number }>({ name: 'searchIndex.pendingProject', sql: 'SELECT COALESCE(SUM(pending), 0) AS pending FROM search_index_status WHERE project_id = ?1' }),
  named: read<[projects: string], { pending: number }>({ name: 'searchIndex.pendingNamed',
    sql: 'SELECT COALESCE(SUM(pending), 0) AS pending FROM search_index_status WHERE project_id IN (SELECT value FROM json_each(?1))' }),
  all: read<[], { pending: number }>({ name: 'searchIndex.pendingAll',
    sql: 'SELECT COALESCE(SUM(s.pending), 0) AS pending FROM search_index_status s WHERE s.project_id IN (SELECT project_id FROM projects WHERE archived_at IS NULL)' }),
  deployment: read<[], { pending: number }>({ name: 'searchIndex.pendingDeployment', sql: 'SELECT COALESCE(SUM(pending), 0) AS pending FROM search_index_status' }),
};
const WAITING_SINCE = read<[], { since: number | null }>({ name: 'searchIndex.waitingSince', sql: `SELECT MIN(pending_since) AS since FROM search_blobs WHERE state = 'pending'` });

/** Plan bodies waiting for the index, in one Project, a set, or the whole Deployment: `building` until every existing body is counted. */
export async function pendingSearchBlobs(db: RelationalStore, reach?: string | ProjectSet): Promise<number | 'building'> {
  const count = reach === undefined ? PENDING.deployment.bind() : typeof reach === 'string' ? PENDING.project.bind(reach)
    : reach.all ? PENDING.all.bind() : PENDING.named.bind(JSON.stringify(reach.projectIds));
  const [ready, rows] = await readSet(db, READY.bind(), count);
  return ready[0]?.done === 1 ? Number(rows[0]?.pending ?? 0) : 'building';
}

/** The Deployment's waiting plan bodies and when the longest-waiting began to wait, for Health. */
export async function searchBacklog(db: RelationalStore): Promise<{ pending: number; oldestStoredAt: number | null }> {
  const [rows, waiting] = await readSet(db, PENDING.deployment.bind(), WAITING_SINCE.bind());
  return { pending: Number(rows[0]?.pending ?? 0), oldestStoredAt: waiting[0]?.since ?? null };
}
