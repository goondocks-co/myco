import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase, getDatabase, closeDatabase } from '@myco/db/client.js';

describe('PGlite client', () => {
  afterEach(async () => {
    // Ensure clean state between tests
    try {
      await closeDatabase();
    } catch {
      // Already closed or never initialized — fine
    }
  });

  it('throws if getDatabase() called before init', () => {
    expect(() => getDatabase()).toThrow(/not initialized/i);
  });

  it('initializes an in-memory database', async () => {
    const db = await initDatabase();
    expect(db).toBeDefined();

    // Verify it's a working PGlite instance
    const result = await db.query<{ val: number }>('SELECT 1 as val');
    expect(result.rows[0].val).toBe(1);
  });

  it('returns the same instance on subsequent getDatabase() calls', async () => {
    const db1 = await initDatabase();
    const db2 = getDatabase();
    expect(db2).toBe(db1);
  });

  it('returns the same instance if initDatabase() called twice (idempotent)', async () => {
    const db1 = await initDatabase();
    const db2 = await initDatabase();
    expect(db2).toBe(db1);
  });

  it('enables pgvector extension', async () => {
    const db = await initDatabase();
    // pgvector creates the vector type — query the extension catalog
    const result = await db.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname = 'vector'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].extname).toBe('vector');
  });

  it('closes cleanly and resets state', async () => {
    await initDatabase();
    await closeDatabase();

    // After close, getDatabase() should throw again
    expect(() => getDatabase()).toThrow(/not initialized/i);
  });

  it('can reinitialize after close', async () => {
    await initDatabase();
    await closeDatabase();

    const db = await initDatabase();
    const result = await db.query<{ val: number }>('SELECT 42 as val');
    expect(result.rows[0].val).toBe(42);
  });
});
