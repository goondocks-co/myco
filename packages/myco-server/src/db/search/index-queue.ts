import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../../core/blob-objects.js';
import { processedResourceProofSql } from '../processed-resources.js';
import { assertion, commit, read, readSet, refusalCode, refused, write } from '../index.js';

const CLAIM_LOST = refusalCode('search_index_claim_lost');

interface QueuedBlob { project_id: string; blob_key: string; next_offset: number; attempted_at: number }

/** Only currently referenced text blobs contribute to the search backlog. */
export const SEARCH_BLOB_REFERENCED = `EXISTS (SELECT 1 FROM plans p WHERE p.project_id = q.project_id AND p.blob_key = q.blob_key AND ${processedResourceProofSql('p.project_id', 'plan', 'p.plan_key', 'p.blob_key')})`;

/** The longest-waiting referenced text blob the full-text index has not finished, with its stamp, cursor and object key. */
const next = read<[], QueuedBlob & { object_key: string | null }>({ name: 'searchIndex.next', sql:
  `SELECT q.project_id, q.blob_key, q.next_offset, q.attempted_at, ${registeredObjectKeySql('q.project_id', 'q.blob_key')} AS object_key
    FROM search_blob_queue q
    WHERE q.complete = 0 AND (${SEARCH_BLOB_REFERENCED}) ORDER BY q.attempted_at, q.project_id, q.blob_key LIMIT 1` });

export async function nextSearchBlob(db: RelationalStore): Promise<(QueuedBlob & { object_key: string | null }) | null> {
  const [rows] = await readSet(db, next.bind());
  return rows[0] ?? null;
}
interface IndexedChunk { offset: number; text: string }

/**
 * Claims a queued blob as read, for one pass: its stamp moves past both `now` and the stamp read, so every claim holds a
 * generation no other claim holds. Null when another pass claimed it or moved its cursor first.
 */
const claim = write<[now: number, project: string, blob: string, stamp: number, offset: number], { attempted_at: number }>({ name: 'searchIndex.claim', sql:
  `UPDATE search_blob_queue SET attempted_at = MAX(?1, attempted_at + 1)
    WHERE project_id = ?2 AND blob_key = ?3 AND attempted_at = ?4 AND next_offset = ?5 AND complete = 0 RETURNING attempted_at` });
const held = assertion<[project: string, blob: string, generation: number, offset: number]>({ name: 'searchIndex.held', refusal: CLAIM_LOST, when: `EXISTS (SELECT 1 FROM search_blob_queue WHERE project_id = ? AND blob_key = ? AND attempted_at = ? AND next_offset = ?)` });
const chunk = write<[project: string, blob: string, offset: number, text: string], { rowid: number }>({ name: 'searchIndex.chunk', sql:
  'INSERT OR IGNORE INTO search_blob_chunks(project_id, blob_key, offset, text) VALUES (?, ?, ?, ?) RETURNING rowid' });
const advance = write<[next: number, complete: number, project: string, blob: string]>({ name: 'searchIndex.advance', sql:
  'UPDATE search_blob_queue SET next_offset = ?, complete = ? WHERE project_id = ? AND blob_key = ?' });

export async function claimSearchBlob(db: RelationalStore, row: QueuedBlob, now: number): Promise<number | null> {
  const [claimed] = await commit(db, claim.bind(now, row.project_id, row.blob_key, row.attempted_at, row.next_offset));
  return claimed.results[0]?.attempted_at ?? null;
}

/**
 * Stores a pass's chunks and moves the blob's cursor past them in one batch, only while the pass's claim still holds the
 * blob at the offset it read from. Answers the chunks stored, or null when the pass no longer holds its claim and stores nothing.
 */
export async function commitSearchChunks(db: RelationalStore, row: QueuedBlob, generation: number, chunks: readonly IndexedChunk[],
  next: { offset: number; complete: boolean }): Promise<number | null> {
  try {
    const results = await commit(db,
      held.bind(row.project_id, row.blob_key, generation, row.next_offset),
      ...chunks.map(c => chunk.bind(row.project_id, row.blob_key, c.offset, c.text)),
      advance.bind(next.offset, next.complete ? 1 : 0, row.project_id, row.blob_key));
    return results.slice(1, 1 + chunks.length).reduce((n, r) => n + r.results.length, 0);
  } catch (error) {
    if (refused(error, CLAIM_LOST)) return null;
    throw error;
  }
}
