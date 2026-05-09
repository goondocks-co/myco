import { openDatabase, type Database } from '@myco/db/client.js';
import type { EmbeddingManager, SqliteVecVectorStore } from './embedding/index.js';

export interface GroveRuntimeEntry {
  databasePath: string;
  db: Database;
  vectorStore?: SqliteVecVectorStore;
  embeddingManager?: EmbeddingManager;
}

export interface EmbeddingRuntimeFactory {
  (db: Database, databasePath: string): { vectorStore: SqliteVecVectorStore; embeddingManager: EmbeddingManager };
}

export interface GroveRuntimeCacheOptions {
  capacity?: number;
}

/**
 * Default cache capacity. Sized for many-Grove machines: a developer
 * with 8–16 active Groves should hit warm cache on every tick rather
 * than thrash. The previous default of 8 was sized for the single-
 * Grove era and left every additional Grove paying re-open cost on
 * housekeeping fan-outs that walk the full set.
 *
 * Use `recommendCapacity(groveCount)` from a caller that knows the
 * registry size to auto-tune above the default.
 */
export const DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY = 32;

/**
 * Hard ceiling on auto-sized capacity. Even on a machine with many
 * Groves, holding more than this many open SQLite handles + vector
 * stores at once is wasteful — better to let the LRU recycle the cold
 * tail.
 */
export const GROVE_RUNTIME_CACHE_CEILING = 128;

/**
 * Suggest a cache capacity given the Grove count. Returns at least
 * `DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY` and never exceeds
 * `GROVE_RUNTIME_CACHE_CEILING`. Roughly sized to `groveCount * 2` so
 * a fan-out + a concurrent operator action both fit without eviction.
 */
export function recommendCapacity(groveCount: number): number {
  const computed = Math.max(DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY, groveCount * 2);
  return Math.min(GROVE_RUNTIME_CACHE_CEILING, computed);
}

/**
 * Bounded LRU cache for per-Grove runtime resources held by the global
 * daemon: SQLite handle, vector store, and embedding manager.
 *
 * Replaces the two ad-hoc Maps that previously grew without bound for
 * the daemon's lifetime (one in DaemonServer for the request DB, one
 * in main.ts for the embedding runtime).
 *
 * Iteration order is the LRU order; touching an entry moves it to the
 * tail. When `capacity` is exceeded, the head (least-recently-used) is
 * evicted and its resources closed. better-sqlite3 is synchronous, so
 * an in-flight request cannot race an eviction — the request's DB ops
 * complete before another request can touch the cache.
 *
 * Pinning: a fan-out sweep over N > capacity Groves needs to keep the
 * entry it is currently working on alive across calls that may load
 * other Groves. `pin(path)` / `unpin(path)` increment/decrement a per-
 * entry pin counter; eviction skips pinned entries. The cache may
 * temporarily exceed `capacity` while pins are held — `capacity` is a
 * target, not a hard cap. The excess is reclaimed on the next unpin or
 * insert that has at least one unpinned entry to evict.
 */
export class GroveRuntimeCache {
  private readonly entries = new Map<string, GroveRuntimeEntry>();
  private readonly pinCounts = new Map<string, number>();
  private capacity: number;

  constructor(options: GroveRuntimeCacheOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_GROVE_RUNTIME_CACHE_CAPACITY;
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Currently effective capacity. Exposed for diagnostics and tests.
   * Does not include the temporary excess held by pinned entries.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Grow (only) the cache capacity. Used when the daemon discovers more
   * Groves than the cache was sized for at construction. Capacity may
   * never shrink below the current size — that would require evicting
   * live entries, which conflicts with pinning semantics. Returns the
   * effective capacity after the call.
   *
   * Capped at GROVE_RUNTIME_CACHE_CEILING.
   */
  growCapacity(target: number): number {
    const bounded = Math.min(GROVE_RUNTIME_CACHE_CEILING, target);
    if (bounded > this.capacity) {
      this.capacity = bounded;
    }
    return this.capacity;
  }

  getDatabase(databasePath: string): Database {
    return this.touch(databasePath, () => ({ databasePath, db: openDatabase(databasePath) })).db;
  }

  getEmbeddingRuntime(databasePath: string, factory: EmbeddingRuntimeFactory): GroveRuntimeEntry {
    const entry = this.touch(databasePath, () => ({ databasePath, db: openDatabase(databasePath) }));
    if (!entry.vectorStore || !entry.embeddingManager) {
      const built = factory(entry.db, databasePath);
      entry.vectorStore = built.vectorStore;
      entry.embeddingManager = built.embeddingManager;
    }
    return entry;
  }

  /**
   * Increment the pin count on an entry so eviction skips it. Safe to
   * call before the entry is loaded — pins are tracked separately and
   * apply once `getDatabase`/`getEmbeddingRuntime` materializes the
   * entry. Each `pin` must be balanced by exactly one `unpin`.
   */
  pin(databasePath: string): void {
    this.pinCounts.set(databasePath, (this.pinCounts.get(databasePath) ?? 0) + 1);
  }

  unpin(databasePath: string): void {
    const count = this.pinCounts.get(databasePath) ?? 0;
    if (count <= 1) {
      this.pinCounts.delete(databasePath);
    } else {
      this.pinCounts.set(databasePath, count - 1);
    }
    this.reclaimCapacity();
  }

  /**
   * Convenience wrapper for the common pin/work/unpin pattern. The pin
   * is released even if `fn` throws or rejects. Returns whatever `fn`
   * returns (sync or async).
   */
  withPinned<T>(databasePath: string, fn: () => T): T;
  withPinned<T>(databasePath: string, fn: () => Promise<T>): Promise<T>;
  withPinned<T>(databasePath: string, fn: () => T | Promise<T>): T | Promise<T> {
    this.pin(databasePath);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.unpin(databasePath);
    };
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(release);
      }
      release();
      return result;
    } catch (err) {
      release();
      throw err;
    }
  }

  evict(databasePath: string): void {
    const entry = this.entries.get(databasePath);
    if (!entry) return;
    this.entries.delete(databasePath);
    closeEntry(entry);
  }

  closeAll(): void {
    for (const entry of this.entries.values()) closeEntry(entry);
    this.entries.clear();
    this.pinCounts.clear();
  }

  private isPinned(databasePath: string): boolean {
    return (this.pinCounts.get(databasePath) ?? 0) > 0;
  }

  private touch(databasePath: string, build: () => GroveRuntimeEntry): GroveRuntimeEntry {
    const existing = this.entries.get(databasePath);
    if (existing) {
      // Move to tail by re-inserting.
      this.entries.delete(databasePath);
      this.entries.set(databasePath, existing);
      return existing;
    }
    const entry = build();
    this.entries.set(databasePath, entry);
    // The just-inserted key is soft-protected during its own insertion:
    // when every other entry is pinned, the cache grows rather than
    // discarding the newcomer (which would be useless work).
    this.reclaimCapacity(databasePath);
    return entry;
  }

  /**
   * Drop unpinned LRU entries until the cache is back at or below
   * capacity. If every remaining entry is pinned (or is the
   * `protectedKey` passed by `touch`), the cache stays oversized
   * until a subsequent unpin re-runs reclamation.
   */
  private reclaimCapacity(protectedKey?: string): void {
    while (this.entries.size > this.capacity) {
      let evictKey: string | undefined;
      for (const key of this.entries.keys()) {
        if (key === protectedKey) continue;
        if (!this.isPinned(key)) {
          evictKey = key;
          break;
        }
      }
      if (evictKey === undefined) return;
      const target = this.entries.get(evictKey)!;
      this.entries.delete(evictKey);
      closeEntry(target);
    }
  }
}

function closeEntry(entry: GroveRuntimeEntry): void {
  try { entry.vectorStore?.close(); } catch { /* best-effort */ }
  // EmbeddingManager has no closable resources of its own — its
  // VectorStore (closed above) and EmbeddableRecordSource (which holds
  // the same `db` we close below) are both injected. Symmetry with the
  // vectorStore branch is intentionally GC-only; adding a no-op
  // close() would only be cosmetic.
  try { entry.db.close(); } catch { /* best-effort */ }
}
