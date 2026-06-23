import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  openDatabase,
  withDatabase,
  setOwnedServiceDirForCurrentProcess,
  clearOwnedServiceDirForCurrentProcess,
} from '@myco/db/client.js';

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
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
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

  it('uses scoped database connections inside withDatabase and restores the singleton afterward', () => {
    const singleton = initDatabase();
    const scoped = openDatabase();

    try {
      singleton.prepare('CREATE TABLE singleton_marker (value TEXT)').run();
      scoped.prepare('CREATE TABLE scoped_marker (value TEXT)').run();

      const result = withDatabase(scoped, () => {
        expect(getDatabase()).toBe(scoped);
        return scoped.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scoped_marker'")
          .get() as { name: string };
      });

      expect(result.name).toBe('scoped_marker');
      expect(getDatabase()).toBe(singleton);
      expect(singleton.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'singleton_marker'")
        .get()).toBeTruthy();
    } finally {
      scoped.close();
    }
  });
});

describe('assertOwnsDatabase — home-path ownership gate', () => {
  // Grove id shape: grove_ + 32 hex chars (matches isGroveEraId).
  const GROVE_ID = 'grove_' + 'a'.repeat(32);
  let tmpRoot: string;

  afterEach(() => {
    clearOwnedServiceDirForCurrentProcess();
    try { closeDatabase(); } catch { /* already closed */ }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Create a real SQLite file at <home>/groves/<groveId>/myco.db. */
  function makeGroveDb(mycoHome: string): { db: ReturnType<typeof openDatabase>; dbPath: string } {
    const groveDir = path.join(mycoHome, 'groves', GROVE_ID);
    fs.mkdirSync(groveDir, { recursive: true });
    const dbPath = path.join(groveDir, 'myco.db');
    const db = openDatabase(dbPath);
    return { db, dbPath };
  }

  it('allows a Grove DB inside the owning home groves directory', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-gate-'));
    const homeA = path.join(tmpRoot, 'A', '.myco');
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    const { db } = makeGroveDb(homeA);
    try {
      expect(() => withDatabase(db, () => {})).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('throws Cross-home when a Grove DB is outside the owning home groves directory', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-gate-'));
    const homeA = path.join(tmpRoot, 'A', '.myco');
    const homeB = path.join(tmpRoot, 'B', '.myco');
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    // DB physically lives under homeB but the daemon owns homeA.
    const { db } = makeGroveDb(homeB);
    try {
      expect(() => withDatabase(db, () => {})).toThrow(/Cross-home Grove access is forbidden/);
    } finally {
      db.close();
    }
  });

  it('allows :memory: when ownership is declared (non-grove early-return)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-gate-'));
    const homeA = path.join(tmpRoot, 'A', '.myco');
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    const db = openDatabase(); // opens :memory:
    try {
      expect(() => withDatabase(db, () => {})).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('allows a non-grove path when ownership is declared (groveIdFromDbPath returns null)', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-gate-'));
    const homeA = path.join(tmpRoot, 'A', '.myco');
    setOwnedServiceDirForCurrentProcess(path.join(homeA, 'service'), homeA);
    // A real file that is not under groves/<groveId>/myco.db — groveIdFromDbPath returns null.
    const nonGrovePath = path.join(tmpRoot, 'fixture.db');
    const db = openDatabase(nonGrovePath);
    try {
      expect(() => withDatabase(db, () => {})).not.toThrow();
    } finally {
      db.close();
      fs.rmSync(nonGrovePath, { force: true });
    }
  });

  it('is a no-op when no ownership is declared', () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-client-gate-'));
    const homeB = path.join(tmpRoot, 'B', '.myco');
    // No setOwnedServiceDirForCurrentProcess call — gate is off.
    const { db } = makeGroveDb(homeB);
    try {
      expect(() => withDatabase(db, () => {})).not.toThrow();
    } finally {
      db.close();
    }
  });
});
