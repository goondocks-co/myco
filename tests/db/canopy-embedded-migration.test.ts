import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema, SCHEMA_VERSION } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';

describe('canopy_entries.embedded migration v26', () => {
  it('adds embedded column with default 0 on fresh install', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const cols = db.prepare(`PRAGMA table_info(canopy_entries)`).all() as Array<{
      name: string; dflt_value: string | null; notnull: number;
    }>;
    const embedded = cols.find((c) => c.name === 'embedded');
    expect(embedded).toBeDefined();
    expect(embedded?.dflt_value).toBe('0');
    expect(embedded?.notnull).toBe(0);
  });

  it('upgrades v25 → v26 idempotently', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(`UPDATE schema_version SET version = 25 WHERE version = ?`).run(SCHEMA_VERSION);
    db.prepare(`ALTER TABLE canopy_entries DROP COLUMN embedded`).run();

    createSchema(db);
    createSchema(db); // second call is a no-op

    const cols = db.prepare(`PRAGMA table_info(canopy_entries)`).all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === 'embedded')).toHaveLength(1);
  });

  it('SCHEMA_VERSION is 26', () => {
    expect(SCHEMA_VERSION).toBe(26);
  });

  it('migrateV25ToV26 is a no-op when column already exists', () => {
    const db = new Database(':memory:');
    createSchema(db); // installs at v26 with embedded column
    // Roll the version row back without dropping the column to simulate
    // a vault that was manually patched but not version-stamped.
    db.prepare(`UPDATE schema_version SET version = 25`).run();
    const migration = MIGRATIONS.find((m) => m.version === 26)!;
    expect(() => migration.migrate(db, 'local')).not.toThrow();
    const row = db.prepare(
      `SELECT MAX(version) AS v FROM schema_version`,
    ).get() as { v: number };
    expect(row.v).toBe(26);
  });
});
