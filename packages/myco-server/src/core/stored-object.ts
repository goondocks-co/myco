/**
 * Reading one stored object whose exact size is known in advance.
 *
 * This module owns every stream it opens from the object store. A body it
 * refuses unread is cancelled; a body it reads is cancelled and its reader
 * released once reading ends, whether the object is whole, short, longer
 * than expected, or fails mid-stream, so no refused object holds its
 * connection or file descriptor for a consumer that will never come.
 */
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
