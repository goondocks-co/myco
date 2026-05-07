import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';

describe('GroveRuntimeCache', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-runtime-cache-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function dbPath(name: string): string {
    const file = path.join(workDir, `${name}.db`);
    const db = openDatabase(file);
    createSchema(db);
    db.close();
    return file;
  }

  it('returns the same DB handle for repeat lookups', () => {
    const cache = new GroveRuntimeCache();
    const a = dbPath('a');
    const first = cache.getDatabase(a);
    const second = cache.getDatabase(a);
    expect(first).toBe(second);
    cache.closeAll();
  });

  it('evicts the least-recently-used entry when capacity is exceeded', () => {
    const cache = new GroveRuntimeCache({ capacity: 2 });
    const a = dbPath('a');
    const b = dbPath('b');
    const c = dbPath('c');

    const dbA = cache.getDatabase(a);
    cache.getDatabase(b);
    cache.getDatabase(a); // touch A so B becomes LRU
    cache.getDatabase(c); // should evict B

    expect(cache.size()).toBe(2);
    // A is still cached: same handle reference.
    expect(cache.getDatabase(a)).toBe(dbA);
    cache.closeAll();
  });

  it('closes evicted resources', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    const dbA = cache.getDatabase(a);
    cache.getDatabase(b);
    expect(() => dbA.prepare('SELECT 1').get()).toThrow();
    cache.closeAll();
  });

  it('explicit evict closes and removes the entry', () => {
    const cache = new GroveRuntimeCache();
    const a = dbPath('a');
    const dbA = cache.getDatabase(a);

    cache.evict(a);
    expect(cache.size()).toBe(0);
    expect(() => dbA.prepare('SELECT 1').get()).toThrow();
  });

  it('pin prevents eviction even when capacity is exceeded', () => {
    const cache = new GroveRuntimeCache({ capacity: 2 });
    const a = dbPath('a');
    const b = dbPath('b');
    const c = dbPath('c');

    const dbA = cache.getDatabase(a);
    cache.pin(a);
    cache.getDatabase(b);
    cache.getDatabase(c); // would normally evict A (LRU); pinned, so B goes instead.

    expect(cache.size()).toBe(2);
    expect(cache.getDatabase(a)).toBe(dbA);
    cache.unpin(a);
    cache.closeAll();
  });

  it('cache may temporarily exceed capacity when every entry is pinned', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.pin(a);
    cache.getDatabase(b);
    cache.pin(b);

    expect(cache.size()).toBe(2);
    cache.unpin(a);
    // Next unpin/insert reclaims; nothing inserted, but unpin already triggered reclamation.
    expect(cache.size()).toBe(1);
    cache.unpin(b);
    cache.closeAll();
  });

  it('withPinned releases the pin synchronously', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.withPinned(a, () => {
      cache.getDatabase(b);
      expect(cache.size()).toBe(2);
    });
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('withPinned releases the pin after an async fn settles', async () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    await cache.withPinned(a, async () => {
      cache.getDatabase(b);
      expect(cache.size()).toBe(2);
    });
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('withPinned releases the pin even if fn throws', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    expect(() =>
      cache.withPinned(a, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    cache.getDatabase(b);
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });

  it('balanced pin/unpin pairs leave eviction free to remove the entry', () => {
    const cache = new GroveRuntimeCache({ capacity: 1 });
    const a = dbPath('a');
    const b = dbPath('b');

    cache.getDatabase(a);
    cache.pin(a);
    cache.pin(a);
    cache.unpin(a);
    cache.unpin(a);
    cache.getDatabase(b); // should evict A now that all pins are released
    expect(cache.size()).toBe(1);
    cache.closeAll();
  });
});
