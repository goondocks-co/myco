/**
 * Tests for the v59 -> v60 migration: run-lifecycle bookkeeping columns.
 *
 * Builds a v59-shaped vault (drop the new columns, rewind schema_version to
 * 59), re-runs createSchema to apply migrateV59ToV60, and asserts the three
 * columns materialize with the correct defaults. The migration-matrix suite
 * covers fresh=migrated parity structurally; this test documents the v60
 * delta in isolation.
 */

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function columnInfo(db: Database, table: string, column: string): ColumnInfo | undefined {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return cols.find((c) => c.name === column);
}

/** Build a v59-shaped DB: full schema with the v60 delta removed. */
function seedV59Db(): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.exec('ALTER TABLE agent_runs DROP COLUMN resume_attempts');
  db.exec('ALTER TABLE agent_runs DROP COLUMN run_context');
  db.exec('ALTER TABLE canopy_entries DROP COLUMN describe_attempts');
  db.prepare(`DELETE FROM schema_version WHERE version > 59`).run();
  return db;
}

describe('migrateV59ToV60 — run-lifecycle bookkeeping columns', () => {
  it('adds the three columns with correct defaults, stamping v60', () => {
    const db = seedV59Db();
    expect(columnInfo(db, 'agent_runs', 'resume_attempts')).toBeUndefined();

    createSchema(db);

    const resumeAttempts = columnInfo(db, 'agent_runs', 'resume_attempts');
    expect(resumeAttempts).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
    const runContext = columnInfo(db, 'agent_runs', 'run_context');
    expect(runContext).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
    const describeAttempts = columnInfo(db, 'canopy_entries', 'describe_attempts');
    expect(describeAttempts).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });

    const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);
    db.close();
  });

  it('backfills existing rows with the column defaults', () => {
    const db = seedV59Db();
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('a', 'A', 1)`).run();
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, status) VALUES ('run-1', 'a', 'failed')`,
    ).run();
    db.prepare(
      `INSERT INTO canopy_entries
         (project_id, path, content_hash, size_bytes, token_estimate, line_count, mechanical_updated_at)
       VALUES ('p', 'src/a.ts', 'h', 1, 1, 1, 100)`,
    ).run();

    createSchema(db);

    const run = db.prepare(
      `SELECT resume_attempts, run_context FROM agent_runs WHERE id = 'run-1'`,
    ).get() as { resume_attempts: number; run_context: string | null };
    expect(run.resume_attempts).toBe(0);
    expect(run.run_context).toBeNull();

    const entry = db.prepare(
      `SELECT describe_attempts FROM canopy_entries WHERE path = 'src/a.ts'`,
    ).get() as { describe_attempts: number };
    expect(entry.describe_attempts).toBe(0);
    db.close();
  });

  it('is idempotent — re-running createSchema on a migrated vault is a no-op', () => {
    const db = seedV59Db();
    createSchema(db);
    createSchema(db);
    expect(columnInfo(db, 'agent_runs', 'resume_attempts')).toBeDefined();
    const stamped = (db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as { v: number }).v;
    expect(stamped).toBe(SCHEMA_VERSION);
    db.close();
  });
});
