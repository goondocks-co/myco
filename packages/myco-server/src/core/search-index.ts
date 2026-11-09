import { claimSearchBlob, commitSearchChunks, nextSearchBlob } from '../db/search/index-queue.js';
import type { BlobStore, RelationalStore } from './adapters.js';
import { projectsBoundOnce, type ProjectSet } from '../read/scope.js';

/** Text chunks stay below the hosted store's row bound, including four-byte UTF-8 characters. */
export const SEARCH_CHUNK_CHARS = 64 * 1024;
export const SEARCH_QUERY_MAX_CHARS = 512;
export const SEARCH_CHUNKS_PER_PASS = 16;

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

/**
 * The single writer of derived blob text. A pass claims its blob before reading it, and its chunks and resume cursor
 * land in one transaction only while that claim still holds the blob at the offset read; a pass that lost its claim
 * stores nothing.
 */
export async function reconcileSearchIndex(db: RelationalStore, blobs: BlobStore, now: number): Promise<number> {
  const row = await nextSearchBlob(db);
  if (row === null) return 0;
  const generation = await claimSearchBlob(db, row, now);
  if (generation === null) return 0;
  const held = row.object_key === null ? null : await blobs.get(row.object_key);
  if (held === null) throw new Error('a captured text blob is missing from object storage');
  const page: TextChunk[] = [];
  for await (const chunk of chunks(held.body, row.next_offset)) {
    page.push(chunk);
    if (page.length === SEARCH_CHUNKS_PER_PASS) break;
  }
  const last = page[page.length - 1];
  if (last === undefined) throw new Error('search indexing produced no progress');
  return await commitSearchChunks(db, row, generation, page, { offset: last.nextOffset, complete: last.complete }) ?? 0;
}
