import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, SchemaVersionTooNewError } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import type { Database } from 'bun:sqlite';

/** Stamp an additional, higher schema_version row (the table keeps history). */
function stampVersion(db: Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_version (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT (version) DO NOTHING`,
  ).run(version, epochSeconds());
}

function currentVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

describe('createSchema — newer-than-supported vault', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it('refuses a database stamped above SCHEMA_VERSION', () => {
    stampVersion(db, SCHEMA_VERSION + 1);

    expect(() => createSchema(db)).toThrow(SchemaVersionTooNewError);
  });

  it('reports both versions and states the database was not modified', () => {
    stampVersion(db, SCHEMA_VERSION + 5);

    let caught: unknown;
    try {
      createSchema(db);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SchemaVersionTooNewError);
    const err = caught as SchemaVersionTooNewError;
    expect(err.code).toBe('schema_version_too_new');
    expect(err.foundVersion).toBe(SCHEMA_VERSION + 5);
    expect(err.supportedVersion).toBe(SCHEMA_VERSION);
    expect(err.message).toContain('has not been modified');
  });

  it('leaves the stamped version untouched when it refuses', () => {
    stampVersion(db, SCHEMA_VERSION + 1);

    expect(() => createSchema(db)).toThrow(SchemaVersionTooNewError);

    expect(currentVersion(db)).toBe(SCHEMA_VERSION + 1);
  });

  it('still accepts a database at exactly SCHEMA_VERSION', () => {
    expect(() => createSchema(db)).not.toThrow();
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
  });
});
