import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  createSchema,
  SCHEMA_VERSION,
  SchemaVersionTooNewError,
  setPreMigrationHook,
  type PreMigrationContext,
} from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';

function stampedVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** A current-schema DB whose stamp is rolled back to simulate a pending migration. */
function pendingMigrationDb(fromVersion: number): Database {
  const db = new Database(':memory:');
  createSchema(db);
  db.prepare('DELETE FROM schema_version').run();
  db.prepare(
    'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
  ).run(fromVersion, epochSeconds());
  return db;
}

afterEach(() => {
  setPreMigrationHook(null);
});

describe('createSchema pre-migration hook seam', () => {
  it('invokes the hook before any migration advances the stamped version', () => {
    const from = SCHEMA_VERSION - 1;
    const db = pendingMigrationDb(from);

    const seen: Array<{ ctx: PreMigrationContext; stampAtHookTime: number }> = [];
    setPreMigrationHook((ctx) => {
      seen.push({ ctx, stampAtHookTime: stampedVersion(ctx.db) });
    });

    createSchema(db, 'machine-a');

    expect(seen.length).toBe(1);
    expect(seen[0].ctx.fromVersion).toBe(from);
    expect(seen[0].ctx.toVersion).toBe(SCHEMA_VERSION);
    expect(seen[0].ctx.machineId).toBe('machine-a');
    expect(seen[0].stampAtHookTime).toBe(from);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('a throwing hook aborts the migration with the stamp unchanged', () => {
    const from = SCHEMA_VERSION - 1;
    const db = pendingMigrationDb(from);

    setPreMigrationHook(() => {
      throw new Error('checkpoint failed');
    });

    expect(() => createSchema(db)).toThrow('checkpoint failed');
    expect(stampedVersion(db)).toBe(from);

    // Deregistering the hook lets the same vault migrate normally.
    setPreMigrationHook(null);
    createSchema(db);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is NOT invoked on a fresh install', () => {
    let calls = 0;
    setPreMigrationHook(() => {
      calls += 1;
    });

    const db = new Database(':memory:');
    createSchema(db);

    expect(calls).toBe(0);
    expect(stampedVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('is NOT invoked on a same-version DDL reapply', () => {
    const db = new Database(':memory:');
    createSchema(db);

    let calls = 0;
    setPreMigrationHook(() => {
      calls += 1;
    });

    createSchema(db);
    expect(calls).toBe(0);
  });

  it('is NOT invoked when the vault is newer than the binary (refusal wins)', () => {
    const db = new Database(':memory:');
    createSchema(db);
    db.prepare(
      'INSERT INTO schema_version (version, applied_at) VALUES (?, ?)',
    ).run(SCHEMA_VERSION + 1, epochSeconds());

    let calls = 0;
    setPreMigrationHook(() => {
      calls += 1;
    });

    expect(() => createSchema(db)).toThrow(SchemaVersionTooNewError);
    expect(calls).toBe(0);
  });
});
