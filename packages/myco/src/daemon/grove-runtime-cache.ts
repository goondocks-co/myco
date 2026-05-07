import { openDatabase, type Database } from '@myco/db/client.js';
import type { EmbeddingManager, SqliteVecVectorStore } from './embedding/index.js';

export interface GroveRuntimeEntry {
  databasePath: string;
  db: Database;
  vectorStore?: SqliteVecVectorStore;
  embeddingManager?: EmbeddingManager;
}

export interface EmbeddingRuntimeFactory {
  (db: Database): { vectorStore: SqliteVecVectorStore; embeddingManager: EmbeddingManager };
}

export interface GroveRuntimeCacheOptions {
  capacity?: number;
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
 */
export class GroveRuntimeCache {
  private readonly entries = new Map<string, GroveRuntimeEntry>();
  private readonly capacity: number;

  constructor(options: GroveRuntimeCacheOptions = {}) {
    this.capacity = options.capacity ?? 8;
  }

  size(): number {
    return this.entries.size;
  }

  getDatabase(databasePath: string): Database {
    return this.touch(databasePath, () => ({ databasePath, db: openDatabase(databasePath) })).db;
  }

  getEmbeddingRuntime(databasePath: string, factory: EmbeddingRuntimeFactory): GroveRuntimeEntry {
    const entry = this.touch(databasePath, () => ({ databasePath, db: openDatabase(databasePath) }));
    if (!entry.vectorStore || !entry.embeddingManager) {
      const built = factory(entry.db);
      entry.vectorStore = built.vectorStore;
      entry.embeddingManager = built.embeddingManager;
    }
    return entry;
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
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey)!;
      this.entries.delete(oldestKey);
      closeEntry(oldest);
    }
    return entry;
  }
}

function closeEntry(entry: GroveRuntimeEntry): void {
  try { entry.vectorStore?.close(); } catch { /* best-effort */ }
  try { entry.db.close(); } catch { /* best-effort */ }
}
