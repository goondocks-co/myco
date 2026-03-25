import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, getDatabase, closeDatabase } from '@myco/db/client.js';

describe('SQLite client', () => {
  afterEach(() => {
    // Ensure clean state between tests
    try {
      closeDatabase();
    } catch {
      // Already closed or never initialized — fine
    }
  });

  it('throws if getDatabase() called before init', () => {
    expect(() => getDatabase()).toThrow(/not initialized/i);
  });

  it('initializes an in-memory database', () => {
    const db = initDatabase();
    expect(db).toBeDefined();

    // Verify it's a working better-sqlite3 instance
    const result = db.prepare('SELECT 1 as val').get() as { val: number };
    expect(result.val).toBe(1);
  });

  it('returns the same instance on subsequent getDatabase() calls', () => {
    const db1 = initDatabase();
    const db2 = getDatabase();
    expect(db2).toBe(db1);
  });

  it('returns the same instance if initDatabase() called twice (idempotent)', () => {
    const db1 = initDatabase();
    const db2 = initDatabase();
    expect(db2).toBe(db1);
  });

  it('enables foreign keys', () => {
    const db = initDatabase();
    const row = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    expect(row[0].foreign_keys).toBe(1);
  });

  it('closes cleanly and resets state', () => {
    initDatabase();
    closeDatabase();

    // After close, getDatabase() should throw again
    expect(() => getDatabase()).toThrow(/not initialized/i);
  });

  it('can reinitialize after close', () => {
    initDatabase();
    closeDatabase();

    const db = initDatabase();
    const result = db.prepare('SELECT 42 as val').get() as { val: number };
    expect(result.val).toBe(42);
  });
});
