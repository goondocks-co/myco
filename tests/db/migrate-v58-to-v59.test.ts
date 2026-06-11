/**
 * Tests for the v58 -> v59 migration: session deletion tombstones.
 *
 * Builds a v58-shaped vault (drop the new table, rewind schema_version to
 * 58), re-runs createSchema to apply migrateV58ToV59, and asserts the
 * tombstone table + its project-scope index materialize. The
 * migration-matrix suite covers fresh=migrated parity structurally; this
 * test documents the v59 delta in isolation.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name);
}

function indexExists(db: Database, name: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(name);
}

/** Build a v58-shaped DB: full schema with the v59 delta removed. */
function seedV58Db(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.exec('DROP TABLE IF EXISTS session_tombstones');
  db.prepare(`DELETE FROM schema_version WHERE version > 58`).run();
  return db;
}

describe('migrateV58ToV59 — session tombstones', () => {
  it('creates session_tombstones and its project_id index, stamping v59', () => {
    const db = seedV58Db();
    expect(tableExists(db, 'session_tombstones')).toBe(false);

    createSchema(db);

    expect(tableExists(db, 'session_tombstones')).toBe(true);
    expect(indexExists(db, 'idx_session_tombstones_project_id')).toBe(true);
    const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);

    // Shape of the migrated table matches the fresh DDL contract.
    const cols = (db.prepare(`PRAGMA table_info(session_tombstones)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(['session_id', 'project_id', 'deleted_at', 'source']);
    db.close();
  });

  it('is idempotent — re-running createSchema on a migrated vault is a no-op', () => {
    const db = seedV58Db();
    createSchema(db);
    db.prepare(
      `INSERT INTO session_tombstones (session_id, project_id, deleted_at, source)
       VALUES ('s-keep', NULL, 1, 'api_delete')`,
    ).run();

    createSchema(db);

    const n = (db.prepare(`SELECT COUNT(*) AS n FROM session_tombstones`).get() as { n: number }).n;
    expect(n).toBe(1);
    db.close();
  });
});
