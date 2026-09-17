/**
 * Reading one stored object whose exact size is known in advance.
 *
 * This module owns every stream it opens from the object store. A body it
 * refuses unread is cancelled; a body it reads is cancelled and its reader
 * released once reading ends, whether the object is whole, short, longer
 * than expected, or fails mid-stream, so no refused object holds its
 * connection or file descriptor for a consumer that will never come.
 */
import { SHA256 } from '@stablelib/sha256';
import { collectBounded } from '../bytes.js';
import type { BlobStore } from './adapters.js';

export type StoredObjectRead =
  | { kind: 'absent' }
  | { kind: 'size_mismatch' }
  | { kind: 'read'; bytes: Uint8Array<ArrayBuffer> };

/**
 * The object at `key`, held to `expectedBytes`: the size the store reports
 * must match before the body is read, and the body must deliver exactly that
 * many bytes. Reading stops at the first chunk past the expected size.
 */
export async function readStoredObject(blobs: BlobStore, key: string, expectedBytes: number): Promise<StoredObjectRead> {
  const held = await blobs.get(key);
  if (held === null) return { kind: 'absent' };
  if (held.size !== expectedBytes) {
    await held.body.cancel();
    return { kind: 'size_mismatch' };
  }
  const reader = held.body.getReader();
  try {
    const read = await collectBounded(reader, expectedBytes);
    if (!read.ok || read.bytes.byteLength !== expectedBytes) return { kind: 'size_mismatch' };
    return { kind: 'read', bytes: read.bytes };
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

/** A stored body refused or abandoned unread, cancelled so it holds nothing open for a consumer that never comes. */
export async function discardStoredBody(body: ReadableStream<Uint8Array>): Promise<void> {
  await body.cancel().catch(() => undefined);
}

/** A stored object's body as a stream another store consumes, with what the stream carried once it ends. */
export interface StoredObjectStream {
  stream: ReadableStream<Uint8Array>;
  result(): { bytes: number; overrun: boolean; finished: boolean; sha256: string | null };
  /** Stops the stream and cancels the stored body unless it ended whole, and waits for that cancellation. */
  release(): Promise<void>;
}

/**
 * One stored body streamed to a consumer that writes it elsewhere: every chunk counted, hashed where `measure` asks,
 * and refused past `expectedBytes` as it arrives. Nothing is held beyond the chunk in hand, whatever the object's
 * size. The stream owns the body's reader, so the body is cancelled whoever holds the stream — when `signal` aborts,
 * on an overrun, or on `release` before the stream ended whole — and a consumer that refused, failed or returned
 * without reading every byte leaves no body open behind it.
 */
export function streamStoredObject(
  body: ReadableStream<Uint8Array>, expectedBytes: number, signal: AbortSignal, measure: boolean,
): StoredObjectStream {
  const hash = measure ? new SHA256() : null;
  const held = { bytes: 0, overrun: false, finished: false, released: false };
  const reader = body.getReader();
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  const halt = async (reason: unknown): Promise<void> => {
    if (held.finished || held.released) return;
    held.released = true;
    try { sink?.error(reason); } catch { /* the stream has already ended */ }
    await reader.cancel(reason).catch(() => undefined);
  };
  const stop = (): void => { void halt(signal.reason); };
  signal.addEventListener('abort', stop);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { sink = controller; },
    async pull(controller) {
      const next = await reader.read().catch((error: unknown) => { controller.error(error); return null; });
      if (next === null || held.released) return;
      if (next.done) {
        held.finished = true;
        signal.removeEventListener('abort', stop);
        controller.close();
        return;
      }
      held.bytes += next.value.byteLength;
      if (held.bytes > expectedBytes) {
        held.overrun = true;
        await halt(new Error('a stored object carried more bytes than its size'));
        return;
      }
      hash?.update(next.value);
      controller.enqueue(next.value);
    },
    async cancel(reason) { await halt(reason); },
  }, { highWaterMark: 0 });
  let digest: string | null = null;
  return {
    stream,
    result: () => {
      if (digest === null && hash !== null && held.finished) {
        digest = [...hash.digest()].map((value) => value.toString(16).padStart(2, '0')).join('');
      }
      return { bytes: held.bytes, overrun: held.overrun, finished: held.finished, sha256: digest };
    },
    release: async () => {
      signal.removeEventListener('abort', stop);
      await halt(new Error('a stored object stream was released before it ended'));
    },
  };
}
