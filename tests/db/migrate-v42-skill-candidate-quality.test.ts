import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import type { Database } from 'bun:sqlite';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function getColumnInfo(db: Database, tableName: string): Map<string, ColumnInfo> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
  return new Map(rows.map((row) => [row.name, row]));
}

/**
 * Build a minimal v41-shaped schema covering only what the v42 migration
 * touches: schema_version, agents (FK target), and skill_candidates before
 * the quality/reconciliation metadata columns existed.
 */
function buildV41Schema(db: Database): void {
  db.prepare(
    `CREATE TABLE schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE agents (
       id         TEXT PRIMARY KEY,
       name       TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`,
  ).run();

  db.prepare(
    `CREATE TABLE skill_candidates (
       id              TEXT PRIMARY KEY,
       project_id      TEXT,
       agent_id        TEXT NOT NULL REFERENCES agents(id),
       machine_id      TEXT NOT NULL DEFAULT 'local',
       topic           TEXT NOT NULL,
       rationale       TEXT NOT NULL,
       confidence      REAL NOT NULL DEFAULT 0.0,
       status          TEXT NOT NULL DEFAULT 'identified',
       source_ids      TEXT NOT NULL DEFAULT '[]',
       skill_id        TEXT,
       supersedes      TEXT,
       created_at      INTEGER NOT NULL,
       updated_at      INTEGER NOT NULL,
       approved_at     INTEGER,
       synced_at       INTEGER
     )`,
  ).run();

  db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (41, 1000)`).run();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('agent-1', 'Agent 1', 1000)`).run();
  db.prepare(
    `INSERT INTO skill_candidates (
       id, agent_id, topic, rationale, created_at, updated_at
     ) VALUES (
       'candidate-1', 'agent-1', 'Topic', 'Rationale', 1000, 1000
     )`,
  ).run();
}

describe('migrateV41ToV42 skill candidate quality metadata', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
    buildV41Schema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('SCHEMA_VERSION is 42', () => {
    expect(SCHEMA_VERSION).toBe(42);
  });

  it('is registered in MIGRATIONS at version 42', () => {
    const migration = MIGRATIONS.find((m) => m.version === 42);
    expect(migration, 'v42 migration missing').toBeDefined();
  });

  it('adds quality and reconciliation columns with expected defaults and nullability', () => {
    const before = getColumnInfo(db, 'skill_candidates');
    expect(before.has('quality_score')).toBe(false);

    const migration = MIGRATIONS.find((m) => m.version === 42)!;
    migration.migrate(db, 'local');

    const cols = getColumnInfo(db, 'skill_candidates');
    expect(cols.get('evidence_bundle_id')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });
    expect(cols.get('quality_score')).toMatchObject({
      type: 'REAL',
      notnull: 0,
      dflt_value: null,
    });
    expect(cols.get('quality_failures')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'[]'",
    });
    expect(cols.get('coverage_matches')).toMatchObject({
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'[]'",
    });
    expect(cols.get('last_reconciled_at')).toMatchObject({
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    expect(cols.get('reconciliation_reason')).toMatchObject({
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    });

    const row = db.prepare(
      `SELECT evidence_bundle_id, quality_score, quality_failures, coverage_matches,
              last_reconciled_at, reconciliation_reason
       FROM skill_candidates WHERE id = 'candidate-1'`,
    ).get() as {
      evidence_bundle_id: string | null;
      quality_score: number | null;
      quality_failures: string;
      coverage_matches: string;
      last_reconciled_at: number | null;
      reconciliation_reason: string | null;
    };
    expect(row).toEqual({
      evidence_bundle_id: null,
      quality_score: null,
      quality_failures: '[]',
      coverage_matches: '[]',
      last_reconciled_at: null,
      reconciliation_reason: null,
    });
  });

  it('is idempotent when replayed', () => {
    const migration = MIGRATIONS.find((m) => m.version === 42)!;

    migration.migrate(db, 'local');
    expect(() => migration.migrate(db, 'local')).not.toThrow();

    const cols = getColumnInfo(db, 'skill_candidates');
    expect(cols.has('evidence_bundle_id')).toBe(true);
    const version = db.prepare(`SELECT count(*) AS count FROM schema_version WHERE version = 42`)
      .get() as { count: number };
    expect(version.count).toBe(1);
  });
});
