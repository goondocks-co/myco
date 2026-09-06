import type { BlobStore, RelationalStore } from './adapters.js';

/** Text chunks stay below the hosted store's row bound, including four-byte UTF-8 characters. */
export const SEARCH_CHUNK_CHARS = 64 * 1024;
export const SEARCH_QUERY_MAX_CHARS = 512;
export const SEARCH_CHUNKS_PER_PASS = 16;

/** Only currently referenced text blobs contribute to the search backlog. */
const REFERENCED = `EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id = q.project_id AND p.blob_key = q.blob_key)
  OR EXISTS (SELECT 1 FROM responses r WHERE r.project_id = q.project_id AND r.blob_key = q.blob_key)
  OR EXISTS (SELECT 1 FROM plans p WHERE p.project_id = q.project_id AND p.blob_key = q.blob_key)`;

export async function pendingSearchBlobs(db: RelationalStore, projectId?: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM search_blob_queue q
    WHERE q.complete = 0 AND (${REFERENCED})${projectId === undefined ? '' : ' AND q.project_id = ?'}`)
    .bind(...(projectId === undefined ? [] : [projectId])).first<{ n: number }>();
  return row?.n ?? 0;
}

interface TextChunk { offset: number; text: string; nextOffset: number; complete: boolean }

/** Decode incrementally and overlap chunk boundaries by the maximum query length. Offsets are UTF-16 code units. */
async function* chunks(body: ReadableStream, start: number): AsyncGenerator<TextChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let skip = start;
  let offset = start;
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      let text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (skip > 0) {
        const consumed = Math.min(skip, text.length);
        skip -= consumed;
        text = text.slice(consumed);
      }
      buffer += text;
      while (buffer.length >= SEARCH_CHUNK_CHARS) {
        let end = SEARCH_CHUNK_CHARS;
        if (/[\uD800-\uDBFF]/.test(buffer[end - 1]!)) end -= 1;
        let advance = end - SEARCH_QUERY_MAX_CHARS;
        if (/[\uDC00-\uDFFF]/.test(buffer[advance]!)) advance -= 1;
        yield { offset, text: buffer.slice(0, end), nextOffset: offset + advance, complete: false };
        buffer = buffer.slice(advance);
        offset += advance;
      }
      if (done) {
        if (skip > 0) throw new Error('search blob is shorter than its recorded index offset');
        yield { offset, text: buffer, nextOffset: offset + buffer.length, complete: true };
        return;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** The single writer of derived blob text. A committed chunk and its resume cursor advance in one transaction. */
export async function reconcileSearchIndex(db: RelationalStore, blobs: BlobStore, now: number): Promise<number> {
  const row = await db.prepare(`SELECT q.project_id, q.blob_key, q.next_offset FROM search_blob_queue q
    WHERE q.complete = 0 AND (${REFERENCED}) ORDER BY q.attempted_at, q.project_id, q.blob_key LIMIT 1`)
    .first<{ project_id: string; blob_key: string; next_offset: number }>();
  if (row === null) return 0;
  await db.prepare(`UPDATE search_blob_queue SET attempted_at = ? WHERE project_id = ? AND blob_key = ?`)
    .bind(now, row.project_id, row.blob_key).run();
  const held = await blobs.get(`${row.project_id}/${row.blob_key}`);
  if (held === null) throw new Error('a captured text blob is missing from object storage');
  const page: TextChunk[] = [];
  for await (const chunk of chunks(held.body, row.next_offset)) {
    page.push(chunk);
    if (page.length === SEARCH_CHUNKS_PER_PASS) break;
  }
  const last = page[page.length - 1];
  if (last === undefined) throw new Error('search indexing produced no progress');
  const insertions = page.map((c) => db.prepare(`INSERT OR IGNORE INTO search_blob_chunks(project_id, blob_key, offset, text)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM search_blob_queue WHERE project_id = ? AND blob_key = ?) RETURNING rowid`)
    .bind(row.project_id, row.blob_key, c.offset, c.text, row.project_id, row.blob_key));
  const results = await db.batch([...insertions,
    db.prepare(`UPDATE search_blob_queue SET next_offset = MAX(next_offset, ?), complete = MAX(complete, ?)
      WHERE project_id = ? AND blob_key = ?`)
      .bind(last.nextOffset, last.complete ? 1 : 0, row.project_id, row.blob_key),
  ]);
  return results.slice(0, page.length).reduce((n, r) => n + r.results.length, 0);
}
