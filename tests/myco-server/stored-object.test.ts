import { describe, expect, it } from 'bun:test';
import type { BlobStore } from '@myco-server-worker/core/adapters.js';
import { readStoredObject } from '@myco-server-worker/core/stored-object.js';

const CHUNK = 1024;

/** A body of 1 KiB chunks pulled only on read, recording what it delivered and whether its consumer cancelled it. */
function body(totalBytes: number, opts: { failAfterBytes?: number } = {}) {
  const state = { sent: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (opts.failAfterBytes !== undefined && state.sent >= opts.failAfterBytes) return c.error(new Error('storage read failed'));
      if (state.sent >= totalBytes) return c.close();
      const size = Math.min(CHUNK, totalBytes - state.sent);
      state.sent += size;
      c.enqueue(new Uint8Array(size).fill(0x62));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, state };
}

/** A store holding one object whose reported size and delivered body are chosen independently. */
const storeOf = (object: { size: number; stream: ReadableStream<Uint8Array> } | null): BlobStore => ({
  head: async () => (object === null ? null : { size: object.size }),
  get: async () => (object === null ? null : { size: object.size, body: object.stream }),
  put: async () => { throw new Error('read-only fixture'); },
  delete: async () => { throw new Error('read-only fixture'); },
});

describe('reading a stored object of known size', () => {
  it('answers exactly the expected bytes and releases the stream', async () => {
    const { stream, state } = body(4 * CHUNK);
    const read = await readStoredObject(storeOf({ size: 4 * CHUNK, stream }), 'k', 4 * CHUNK);
    expect(read.kind).toBe('read');
    if (read.kind === 'read') expect(read.bytes.byteLength).toBe(4 * CHUNK);
    expect({ sent: state.sent, locked: stream.locked }).toEqual({ sent: 4 * CHUNK, locked: false });
  });

  it('cancels a body whose reported size differs without reading any of it', async () => {
    const { stream, state } = body(4 * CHUNK);
    expect(await readStoredObject(storeOf({ size: 4 * CHUNK, stream }), 'k', 3 * CHUNK)).toEqual({ kind: 'size_mismatch' });
    expect({ sent: state.sent, cancelled: state.cancelled, locked: stream.locked }).toEqual({ sent: 0, cancelled: true, locked: false });
  });

  it('stops reading a body that delivers more than its reported size, then cancels and releases it', async () => {
    const { stream, state } = body(64 * CHUNK);
    expect(await readStoredObject(storeOf({ size: 8 * CHUNK, stream }), 'k', 8 * CHUNK)).toEqual({ kind: 'size_mismatch' });
    expect({ sent: state.sent, cancelled: state.cancelled, locked: stream.locked }).toEqual({ sent: 9 * CHUNK, cancelled: true, locked: false });
  });

  it('refuses a body that ends short of its reported size and releases it', async () => {
    const { stream } = body(3 * CHUNK);
    expect(await readStoredObject(storeOf({ size: 4 * CHUNK, stream }), 'k', 4 * CHUNK)).toEqual({ kind: 'size_mismatch' });
    expect(stream.locked).toBe(false);
  });

  it('propagates a failure mid-stream and still releases the reader', async () => {
    const { stream } = body(8 * CHUNK, { failAfterBytes: 2 * CHUNK });
    await expect(readStoredObject(storeOf({ size: 8 * CHUNK, stream }), 'k', 8 * CHUNK)).rejects.toThrow('storage read failed');
    expect(stream.locked).toBe(false);
  });

  it('answers absent for an object the store does not hold', async () => {
    expect(await readStoredObject(storeOf(null), 'k', 1)).toEqual({ kind: 'absent' });
  });
});
