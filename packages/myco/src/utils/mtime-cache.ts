import fs from 'node:fs';

export interface MtimeCache<T> {
  get(filePath: string): T;
  invalidate(filePath: string): void;
  clear(): void;
}

interface Entry<T> {
  mtimeMs: number | null;
  size: number | null;
  value: T;
}

/**
 * Memoizes `loader` keyed on a file's mtime + size.
 *
 * On each `get`, stats the file. If the cached entry's mtimeMs and size
 * still match (or both indicate the file is missing), returns the cached
 * value. Otherwise calls `loader` and stores the new result.
 *
 * In-process writes should call `invalidate(path)` after the write so a
 * same-millisecond rewrite doesn't return stale content. External edits
 * self-invalidate via mtime/size.
 *
 * Returned values are shared across callers — do not mutate them.
 */
export function createMtimeCache<T>(loader: (filePath: string) => T): MtimeCache<T> {
  const cache = new Map<string, Entry<T>>();
  return {
    get(filePath) {
      let mtimeMs: number | null = null;
      let size: number | null = null;
      try {
        const stat = fs.statSync(filePath);
        mtimeMs = stat.mtimeMs;
        size = stat.size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const cached = cache.get(filePath);
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        return cached.value;
      }
      const value = loader(filePath);
      cache.set(filePath, { mtimeMs, size, value });
      return value;
    },
    invalidate(filePath) { cache.delete(filePath); },
    clear() { cache.clear(); },
  };
}
