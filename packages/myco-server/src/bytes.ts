/** Bounded byte collection from a stream reader, shared by every reader that holds a stream to a byte bound. */

export type BoundedBytes = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false };

/** The part of a stream reader collection reads through. Typed structurally: a runtime may add its own methods to the reader, and this needs only `read`. */
export interface ChunkReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

/**
 * Collects bytes from `reader` up to `max`, counting what the stream actually
 * delivers rather than any size declared for it. The first chunk past `max`
 * ends collection without another read; the reader's owner decides what
 * happens to the rest of its stream.
 */
export async function collectBounded(reader: ChunkReader, max: number): Promise<BoundedBytes> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) break;
    total += value.byteLength;
    if (total > max) return { ok: false };
    chunks.push(value);
  }
  return { ok: true, bytes: concat(chunks, total) };
}

/** The collected chunks as one view: a lone chunk over an `ArrayBuffer` is returned as a view of it, and anything else is copied into a buffer this function allocates. */
function concat(chunks: Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const [only] = chunks;
  if (chunks.length === 1 && only !== undefined && only.buffer instanceof ArrayBuffer) {
    return new Uint8Array(only.buffer, only.byteOffset, only.byteLength);
  }
  const joined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
  return joined;
}
