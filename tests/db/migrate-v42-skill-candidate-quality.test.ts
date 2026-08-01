import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import { SCHEMA_VERSION, createSchema } from '@myco/db/schema.js';
import { Database } from 'bun:sqlite';

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

  it('SCHEMA_VERSION reflects the latest migration', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
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

  it('rolls back the ALTER chain and schema_version when a mid-migration ALTER throws', () => {
    const migration = MIGRATIONS.find((m) => m.version === 42)!;

    const originalExec = db.exec.bind(db);
    const failingExec = (sql: string): void => {
      if (sql.includes('coverage_matches')) {
        throw new Error('simulated mid-migration failure');
      }
      return originalExec(sql);
    };
    db.exec = failingExec as typeof db.exec;

    try {
      expect(() => migration.migrate(db, 'local')).toThrow('simulated mid-migration failure');
    } finally {
      db.exec = originalExec;
    }

    const cols = getColumnInfo(db, 'skill_candidates');
    expect(cols.has('evidence_bundle_id'), 'evidence_bundle_id should have rolled back').toBe(false);
    expect(cols.has('quality_score'), 'quality_score should have rolled back').toBe(false);
    expect(cols.has('quality_failures'), 'quality_failures should have rolled back').toBe(false);
    expect(cols.has('coverage_matches')).toBe(false);
    expect(cols.has('last_reconciled_at')).toBe(false);
    expect(cols.has('reconciliation_reason')).toBe(false);

    const version = db.prepare(
      `SELECT count(*) AS count FROM schema_version WHERE version = 42`,
    ).get() as { count: number };
    expect(version.count, 'schema_version row for v42 must not exist after rollback').toBe(0);

    expect(() => migration.migrate(db, 'local')).not.toThrow();
    const versionAfter = db.prepare(
      `SELECT count(*) AS count FROM schema_version WHERE version = 42`,
    ).get() as { count: number };
    expect(versionAfter.count).toBe(1);
  });
});

describe('skill_candidates column shape: fresh install ≡ upgraded vault', () => {
  it('produces an identical column set and order whether built from fresh DDL or v41→v42 ALTERs', () => {
    const upgraded = initDatabase();
    try {
      const v41Db = upgraded;
      v41Db.prepare(
        `CREATE TABLE schema_version (
           version    INTEGER PRIMARY KEY,
           applied_at INTEGER NOT NULL
         )`,
      ).run();
      v41Db.prepare(
        `CREATE TABLE agents (
           id         TEXT PRIMARY KEY,
           name       TEXT NOT NULL,
           created_at INTEGER NOT NULL
         )`,
      ).run();
      v41Db.prepare(
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
      v41Db.prepare(`INSERT INTO schema_version (version, applied_at) VALUES (41, 1000)`).run();

      MIGRATIONS.find((m) => m.version === 42)!.migrate(v41Db, 'local');

      const upgradedCols = (
        v41Db.prepare(`PRAGMA table_info(skill_candidates)`).all() as Array<{ cid: number; name: string }>
      )
        .slice()
        .sort((a, b) => a.cid - b.cid)
        .map((col) => col.name);

      const fresh = new Database(':memory:');
      try {
        createSchema(fresh, 'local');
        const freshCols = (
          fresh.prepare(`PRAGMA table_info(skill_candidates)`).all() as Array<{ cid: number; name: string }>
        )
          .slice()
          .sort((a, b) => a.cid - b.cid)
          .map((col) => col.name);

        // This fixture upgrades a frozen v41 vault through migration 42 ONLY,
        // so columns added by LATER migrations exist on the fresh side alone.
        // Filter them by name; full-chain order parity for these columns is
        // asserted by their own migration tests (v75:
        // migrate-v74-to-v75-residency-trust.test.ts).
        const POST_V42_COLUMNS = new Set(['received_at']);
        const comparableFresh = freshCols.filter((c) => !POST_V42_COLUMNS.has(c));

        expect(new Set(comparableFresh), 'column NAME SET must match between fresh and upgraded').toEqual(
          new Set(upgradedCols),
        );

        expect(comparableFresh, 'column ORDER must match — prevents PRAGMA-positional drift between vaults').toEqual(
          upgradedCols,
        );
      } finally {
        fresh.close();
      }
    } finally {
      closeDatabase();
    }
  });
});
