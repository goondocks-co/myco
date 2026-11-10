import { SEARCH_QUERY_MAX_CHARS } from '@goondocks/myco-shared/search-types';
import type { BlobStore, RelationalStore } from './adapters.js';
import {
  claimSearchBlob, commitSearchChunks, dueSearchBlob, failSearchBlob, retireSearchChunks, type DueBlob, type IndexedChunk,
} from '../db/search/blob-index.js';

/**
 * The one writer of a stored plan body's search text. Each pass takes the soonest due blob. A waiting blob is claimed
 * under a short lease, its bytes are read from the recorded byte onward as one bounded range, cut into chunks at character
 * boundaries that overlap by a query's length, and committed as chunk documents with the next byte, only while the
 * claim, the blob's generation and a live proved reference still hold. A leaving blob loses a bounded page of its chunk
 * documents per pass. A pass reads the same number of bytes wherever in the blob it starts.
 */

/** One chunk document's text, in UTF-8 bytes: well below the hosted store's bound on a statement's bound value. */
export const SEARCH_CHUNK_BYTES = 64 * 1024;
/** Chunks one pass commits. */
export const SEARCH_CHUNKS_PER_PASS = 16;
/** Bytes consecutive chunks share, so a phrase as long as the longest query lands whole in one of them. */
const SEARCH_CHUNK_OVERLAP_BYTES = SEARCH_QUERY_MAX_CHARS * 4;
/** Bytes one pass requests from the blob store. */
const SEARCH_PASS_BYTES = SEARCH_CHUNK_BYTES + (SEARCH_CHUNKS_PER_PASS - 1) * (SEARCH_CHUNK_BYTES - SEARCH_CHUNK_OVERLAP_BYTES);
/** Chunk documents one pass removes from a leaving blob. */
export const SEARCH_RETIRE_PER_PASS = 64;
/** How long a claimed pass holds its blob before another pass may take it up. */
export const SEARCH_CLAIM_LEASE_MS = 60_000;
const RETRY_MS = 10 * 60_000;

/** The blob's facets: its chunks are found within its Project, as chunks. */
const hex = (value: string) => [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const continuation = (byte: number) => (byte & 0xc0) === 0x80;
/** `at`, moved back to the first byte of the character it falls in. */
function leadByte(bytes: Uint8Array, at: number): number {
  let i = at;
  while (i > 0 && i < bytes.length && continuation(bytes[i]!)) i -= 1;
  return i;
}

interface CutPass { chunks: IndexedChunk[]; nextByte: number; complete: boolean }

/** Cuts `bytes` (the blob from `start`, of `size` bytes in all) into chunks; the frontier is always a character's first byte. */
function cutChunks(bytes: Uint8Array, start: number, size: number): CutPass {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: IndexedChunk[] = [];
  let at = 0;
  for (;;) {
    const reachesEnd = start + bytes.length >= size && at + SEARCH_CHUNK_BYTES >= bytes.length;
    const end = reachesEnd ? bytes.length : leadByte(bytes, Math.min(bytes.length, at + SEARCH_CHUNK_BYTES));
    chunks.push({ byteOffset: start + at, text: decoder.decode(bytes.subarray(at, end)) });
    if (reachesEnd) return { chunks, nextByte: start + bytes.length, complete: true };
    const next = leadByte(bytes, end - SEARCH_CHUNK_OVERLAP_BYTES);
    if (chunks.length === SEARCH_CHUNKS_PER_PASS || (next + SEARCH_CHUNK_BYTES > bytes.length && start + bytes.length < size)) return { chunks, nextByte: start + next, complete: false };
    at = next;
  }
}

/** Up to one pass of the blob's bytes from `offset`, never past its registered `size`. */
async function readRange(blobs: BlobStore, key: string, offset: number, size: number): Promise<{ bytes: Uint8Array; size: number } | null> {
  if (offset >= size) return { bytes: new Uint8Array(0), size };
  const held = await blobs.get(key, { range: { offset, length: Math.min(SEARCH_PASS_BYTES, size - offset) } });
  if (held === null) return null;
  return { bytes: new Uint8Array(await new Response(held.body).arrayBuffer()), size: held.size };
}

/** One pass over the soonest due blob. Answers the chunk documents written or removed. */
export async function reconcileSearchIndex(db: RelationalStore, blobs: BlobStore, now: number): Promise<number> {
  const blob = await dueSearchBlob(db, now);
  if (blob === null) return 0;
  if (blob.state === 'retiring') return (await retireSearchChunks(db, blob, SEARCH_RETIRE_PER_PASS)).removed;
  return indexPass(db, blobs, blob, now);
}

async function indexPass(db: RelationalStore, blobs: BlobStore, blob: DueBlob, now: number): Promise<number> {
  const claimed = await claimSearchBlob(db, blob, now, now + SEARCH_CLAIM_LEASE_MS);
  if (claimed === null) return 0;
  let cut: CutPass;
  try {
    const range = blob.object_key === null || blob.size === null ? null : await readRange(blobs, blob.object_key, blob.next_byte, Number(blob.size));
    if (range === null) throw new Error('blob_missing');
    cut = cutChunks(range.bytes, blob.next_byte, range.size);
  } catch (error) {
    await failSearchBlob(db, blob, claimed, error instanceof Error && error.message === 'blob_missing' ? 'blob_missing' : 'blob_unreadable', now + RETRY_MS);
    return 0;
  }
  return await commitSearchChunks(db, blob, claimed, {
    chunks: cut.chunks, nextByte: cut.nextByte, complete: cut.complete, recordAt: blob.received_at ?? now, facets: `p${hex(blob.project_id)} kchunk`,
  }) ?? 0;
}
