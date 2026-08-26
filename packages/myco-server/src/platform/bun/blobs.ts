/**
 * The self-hosted blob store: content-addressed objects on the mounted volume.
 *
 * It provides the semantics the core depends on: `put` verifies a declared digest
 * against the bytes actually received and rejects a mismatch, and it reports the
 * size the store recorded rather than the size the caller declared. A partially
 * written object never appears under its final name — bytes land on a temporary
 * path and are renamed only once the digest holds.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BlobPutOptions, BlobStore, StoredObject, StoredObjectBody } from '../../core/adapters.js';

/** The message a digest rejection carries. This store's own platform recognises it; shared code matches no message text. */
export const DIGEST_MISMATCH_MESSAGE = 'stored bytes do not match the declared sha256 digest';

/** Keys are project-prefixed and content-addressed; both segments are server-issued, never caller text. A key that escapes the root is refused rather than written. */
function resolveWithin(root: string, key: string): string {
  const full = path.resolve(root, key);
  const bounded = path.resolve(root) + path.sep;
  if (!full.startsWith(bounded)) throw new Error(`blob key escapes the store root: ${key}`);
  return full;
}

/**
 * The stats of a stored object, or null when no object is stored under the key.
 *
 * Only a genuine absence answers null. Any other failure — a permission error, an
 * I/O error, an unmounted volume — is rethrown, so a storage outage is never
 * reported to a caller as "this object does not exist", which is indistinguishable
 * from data loss. A key that resolves to something other than a regular file is an
 * absence: the store's namespace is flat, and a directory is not an object in it.
 */
async function statObject(file: string): Promise<Stats | null> {
  let stat: Stats;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
  return stat.isFile() ? stat : null;
}

/** The suffix a partially written object carries until its digest holds and it is renamed. */
const PARTIAL_SUFFIX = '.partial';

/**
 * Removes temporary objects a previous process left behind. A kill between the
 * first write and the rename strands one, and nothing else ever reclaims it. They
 * are outside the key space, so this frees space rather than changing behavior.
 */
export async function sweepPartialObjects(root: string): Promise<number> {
  let swept = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(PARTIAL_SUFFIX)) { await fs.rm(full, { force: true }); swept += 1; }
    }
  };
  await walk(root);
  return swept;
}

export function diskBlobStore(root: string): BlobStore {
  const pathFor = (key: string) => resolveWithin(root, key);

  return {
    async head(key) {
      const stat = await statObject(pathFor(key));
      return stat === null ? null : { size: stat.size };
    },

    async get(key): Promise<StoredObjectBody | null> {
      const file = pathFor(key);
      const stat = await statObject(file);
      if (stat === null) return null;
      const size = stat.size;
      // The descriptor belongs to the stream, opened on first read and released
      // whether the body is drained, cancelled, or abandoned unread. A handle
      // opened here and closed only at end-of-stream leaks one per response the
      // reader never consumes, which an owner navigating away produces routinely.
      return { size, body: Bun.file(file).stream() };
    },

    async put(key, value, options?: BlobPutOptions): Promise<StoredObject> {
      const file = pathFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${crypto.randomUUID()}${PARTIAL_SUFFIX}`;
      const digest = createHash('sha256');
      let size = 0;
      const handle = await fs.open(temporary, 'w');
      try {
        if (value !== null) {
          const reader = value.getReader();
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            digest.update(chunk);
            size += chunk.byteLength;
            await handle.write(chunk);
          }
        }
        await handle.close();
        if (options?.sha256 !== undefined && digest.digest('hex') !== options.sha256) {
          throw new Error(DIGEST_MISMATCH_MESSAGE);
        }
        await fs.rename(temporary, file);
        return { size };
      } catch (err) {
        await handle.close().catch(() => {});
        await fs.rm(temporary, { force: true });
        throw err;
      }
    },

    async delete(key) {
      await fs.rm(pathFor(key), { force: true });
    },
  };
}
