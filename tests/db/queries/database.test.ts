import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import {
  getDatabaseFileStats,
  getTablesBreakdown,
  getIndexesList,
  getSchemaInfo,
  getLastDatabaseLogTimestamp,
  runVacuum,
  runAnalyze,
  runReindex,
  runIntegrityCheck,
  runForeignKeyCheck,
  runWalCheckpointTruncate,
  runPragmaOptimize,
  runFtsOptimize,
  listFtsTableNames,
} from '@myco/db/queries/database';

describe('database queries — introspection', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-db-test-'));
    dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getDatabaseFileStats returns size + page info from a real DB file', () => {
    const stats = getDatabaseFileStats(dbPath);
    expect(stats.path).toBe(dbPath);
    expect(stats.size_bytes).toBeGreaterThan(0);
    expect(stats.page_size).toBeGreaterThan(0);
    expect(stats.page_count).toBeGreaterThan(0);
    expect(stats.freelist_count).toBeGreaterThanOrEqual(0);
    expect(stats.fragmentation_pct).toBeGreaterThanOrEqual(0);
    expect(stats.fragmentation_pct).toBeLessThanOrEqual(100);
    expect(typeof stats.wal_size_bytes).toBe('number');
  });

  it('getTablesBreakdown returns one row per user table with row counts and index counts', () => {
    const tables = getTablesBreakdown();
    expect(tables.length).toBeGreaterThan(0);
    const sessions = tables.find((t) => t.name === 'sessions');
    expect(sessions).toBeDefined();
    expect(sessions!.rows).toBe(0);
    expect(sessions!.index_count).toBeGreaterThanOrEqual(0);
    expect(sessions!.is_fts).toBe(false);

    const fts = tables.find((t) => t.name === 'sessions_fts');
    expect(fts).toBeDefined();
    expect(fts!.is_fts).toBe(true);
  });

  it('getIndexesList returns btree and auto indexes with their owning table', () => {
    const indexes = getIndexesList();
    expect(indexes.length).toBeGreaterThan(0);
    for (const idx of indexes) {
      expect(idx.name).toBeTypeOf('string');
      expect(idx.table).toBeTypeOf('string');
      expect(['btree', 'auto']).toContain(idx.type);
    }
    expect(indexes.some((i) => i.type === 'btree')).toBe(true);
    expect(indexes.some((i) => i.type === 'auto')).toBe(true);
  });

  it('getSchemaInfo returns version, journal_mode, foreign_keys', () => {
    const info = getSchemaInfo();
    expect(info.version).toBeGreaterThan(0);
    expect(info.journal_mode.toLowerCase()).toBe('wal');
    expect(typeof info.foreign_keys).toBe('boolean');
  });

  it('getSchemaInfo reports the DB\'s STAMPED version, not the binary constant', () => {
    const db = initDatabase(dbPath);
    const binaryVersion = getSchemaInfo().binary_version;
    // Rewrite the stamp to simulate a vault the binary has not migrated yet.
    db.prepare('DELETE FROM schema_version').run();
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(binaryVersion - 2, 100);

    const info = getSchemaInfo();
    expect(info.version).toBe(binaryVersion - 2);
    expect(info.binary_version).toBe(binaryVersion);
  });

  it('getLastDatabaseLogTimestamp returns null when no matching log entry exists', () => {
    const ts = getLastDatabaseLogTimestamp('database.optimize');
    expect(ts).toBeNull();
  });
});

describe('database queries — maintenance ops', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-db-mnt-'));
    dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runVacuum executes without error', () => {
    expect(() => runVacuum()).not.toThrow();
  });

  it('runAnalyze executes without error', () => {
    expect(() => runAnalyze()).not.toThrow();
  });

  it('runReindex executes without error', () => {
    expect(() => runReindex()).not.toThrow();
  });

  it('runIntegrityCheck returns "ok" for a healthy database', () => {
    const result = runIntegrityCheck();
    expect(result.status).toBe('ok');
    expect(result.issues).toEqual([]);
  });

  it('runForeignKeyCheck returns empty array for a clean DB', () => {
    const violations = runForeignKeyCheck();
    expect(Array.isArray(violations)).toBe(true);
    expect(violations).toEqual([]);
  });

  it('runWalCheckpointTruncate returns a result with busy/log/checkpointed', () => {
    const result = runWalCheckpointTruncate();
    expect(typeof result.busy).toBe('number');
    expect(typeof result.log).toBe('number');
    expect(typeof result.checkpointed).toBe('number');
  });

  it('runPragmaOptimize executes without error', () => {
    expect(() => runPragmaOptimize()).not.toThrow();
  });

  it('runFtsOptimize executes against a known FTS5 virtual table without error', () => {
    expect(() => runFtsOptimize('sessions_fts')).not.toThrow();
  });

  it('runFtsOptimize rejects non-FTS table names', () => {
    expect(() => runFtsOptimize('sessions')).toThrow();
  });

  it('runFtsOptimize rejects a name that passes the regex but does not exist as FTS5', () => {
    expect(() => runFtsOptimize('nonexistent_fts')).toThrow(/Not an FTS5 table/);
  });

  it('listFtsTableNames returns known FTS5 tables from the schema', () => {
    const names = listFtsTableNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain('sessions_fts');
    // All returned names must match the pattern
    for (const name of names) {
      expect(name.endsWith('_fts')).toBe(true);
    }
  });
});
