/** Input volume between reclamation of discarded Bun buffers and statement objects. */
const COLLECTION_BYTES = 32 * 1024 * 1024;

/** Reclaims consumed data at a fixed cadence independent of the runtime's available-memory heap target. */
export async function* boundedMemoryChunks<T>(input: AsyncIterable<T>, bytesOf: (chunk: T) => number): AsyncGenerator<T> {
  let consumed = 0;
  for await (const chunk of input) {
    yield chunk;
    consumed += bytesOf(chunk);
    if (consumed >= COLLECTION_BYTES) {
      Bun.gc(true);
      consumed = 0;
    }
  }
}
