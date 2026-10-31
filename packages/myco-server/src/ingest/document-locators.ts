/**
 * Page locators for the prompts of documents written before `session_prompts.page` existed. A wake reads at most
 * `LOCATE_CHUNKS_PER_WAKE` page chunks, in chunk order from the one after the document's `locate_after`, so each chunk
 * is read once, and records the page of every prompt they hold. A locator the publisher or conversion has already
 * written is kept. Once a document's last page chunk is read, a prompt no page holds is recorded as page -1.
 */
import type { ServerEnv } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { readPageChunk, type ChunkRow } from '../content/document-reader.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached } from './document-batch.js';
import type { PassLimits } from './parse.js';

/** Page chunks one wake reads to locate prompts. */
export const LOCATE_CHUNKS_PER_WAKE = 4;

interface Unlocated { project_id: string; session_id: string; generation: number; locate_after: number | null }

/** Locates prompts of live documents within one wake's share; `more` while any may remain unlocated. */
export async function locatePrompts(env: Pick<ServerEnv, 'db' | 'blobs'>, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const db = env.db;
  let read = 0, changed = 0;
  while (read < LOCATE_CHUNKS_PER_WAKE) {
    if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const doc = await db.prepare(`SELECT p.project_id, p.session_id, p.generation, d.locate_after
      FROM session_prompts p INDEXED BY idx_session_prompts_unlocated
      JOIN session_documents d ON d.project_id = p.project_id AND d.session_id = p.session_id AND d.generation = p.generation AND d.state = 'live'
      WHERE p.page IS NULL LIMIT 1`).first<Unlocated>();
    if (doc === null) return { changed, more: false };
    const share = LOCATE_CHUNKS_PER_WAKE - read;
    const rows = (await db.prepare(`SELECT c.chunk_no, c.blob_key, c.kind, c.bytes, c.source_id,
        ${registeredObjectKeySql('c.project_id', 'c.blob_key')} object_key
      FROM session_chunks c WHERE c.project_id = ?1 AND c.session_id = ?2 AND c.generation = ?3 AND c.kind = 'page' AND c.chunk_no > ?4
      ORDER BY c.chunk_no LIMIT ?5`).bind(doc.project_id, doc.session_id, doc.generation, doc.locate_after ?? -1, share + 1).all<ChunkRow>()).results;
    const chunks = rows.slice(0, share);
    const placed: { id: string; page: number }[] = [];
    for (const row of chunks) {
      for (const page of (await readPageChunk(env, row)).pages) {
        for (const record of page.records) if (record.k === 'prompt') placed.push({ id: record.id, page: page.page });
      }
    }
    read += chunks.length;
    const finished = rows.length <= share;
    const where = 'project_id = ? AND session_id = ? AND generation = ?';
    const key = [doc.project_id, doc.session_id, doc.generation];
    await db.batch([
      db.prepare(`UPDATE session_prompts SET page = json_extract(j.value, '$.page') FROM json_each(?) j
        WHERE ${where} AND prompt_id = json_extract(j.value, '$.id') AND page IS NULL`).bind(JSON.stringify(placed), ...key),
      ...(finished ? [db.prepare(`UPDATE session_prompts SET page = -1 WHERE ${where} AND page IS NULL`).bind(...key)] : []),
      db.prepare(`UPDATE session_documents SET locate_after = ? WHERE ${where} AND state = 'live'`)
        .bind(chunks.at(-1)?.chunk_no ?? doc.locate_after, ...key),
    ]);
    changed += placed.length;
    if (!finished) return { changed, more: true };
  }
  return { changed, more: true };
}
