import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, write } from '../index.js';

const CLAIM_LOST = 'search_index_claim_lost';

export interface QueuedBlob { project_id: string; blob_key: string; next_offset: number; attempted_at: number }
export interface IndexedChunk { offset: number; text: string }

/**
 * Claims a queued blob as read, for one pass: its stamp moves past both `now` and the stamp read, so every claim holds a
 * generation no other claim holds. Null when another pass claimed it or moved its cursor first.
 */
const claim = write<[now: number, project: string, blob: string, stamp: number, offset: number], { attempted_at: number }>({ name: 'searchIndex.claim', sql:
  `UPDATE search_blob_queue SET attempted_at = MAX(?1, attempted_at + 1)
    WHERE project_id = ?2 AND blob_key = ?3 AND attempted_at = ?4 AND next_offset = ?5 AND complete = 0 RETURNING attempted_at` });
const held = assertion<[project: string, blob: string, generation: number, offset: number]>({ name: 'searchIndex.held', sql:
  `SELECT CASE WHEN EXISTS (SELECT 1 FROM search_blob_queue WHERE project_id = ? AND blob_key = ? AND attempted_at = ? AND next_offset = ?)
    THEN 1 ELSE json_extract('[]','$[${CLAIM_LOST}]') END` });
const chunk = write<[project: string, blob: string, offset: number, text: string], { rowid: number }>({ name: 'searchIndex.chunk', sql:
  'INSERT OR IGNORE INTO search_blob_chunks(project_id, blob_key, offset, text) VALUES (?, ?, ?, ?) RETURNING rowid' });
const advance = write<[next: number, complete: number, project: string, blob: string]>({ name: 'searchIndex.advance', sql:
  'UPDATE search_blob_queue SET next_offset = ?, complete = ? WHERE project_id = ? AND blob_key = ?' });

export async function claimSearchBlob(db: RelationalStore, row: QueuedBlob, now: number): Promise<number | null> {
  const [claimed] = await commit(db, claim.bind(now, row.project_id, row.blob_key, row.attempted_at, row.next_offset));
  return claimed.results[0]?.attempted_at ?? null;
}

function lost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes(CLAIM_LOST) || lost(error.cause);
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
    if (lost(error)) return null;
    throw error;
  }
}
