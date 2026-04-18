/**
 * SQLite database schema -- all capture, intelligence, and agent state tables.
 *
 * Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout
 * for idempotency. Running `createSchema()` multiple times is always safe.
 *
 * Timestamp convention: all timestamps are INTEGER (Unix epoch seconds).
 * Content hashing: all `content_hash` columns are TEXT with UNIQUE constraint.
 * Embedding dimensions: 1024 (bge-m3 default) -- used by external sqlite-vec store.
 *
 * Vector columns live in a separate sqlite-vec virtual table, not inline.
 * Tables that participate in vector search carry an `embedded INTEGER DEFAULT 0`
 * flag so the embedder knows which rows still need vectors.
 */

import type { Database } from 'better-sqlite3';
import { epochSeconds, DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { TABLE_DDLS, FTS_TABLES, SECONDARY_INDEXES } from './schema-ddl.js';
import { MIGRATIONS } from './migrations.js';

/** Current schema version -- fresh start for the SQLite era. */
export const SCHEMA_VERSION = 20;

// Re-export for backwards compat (other modules import from schema.ts)
export { DEFAULT_MACHINE_ID };

/** Embedding vector dimensions (bge-m3 default). */
export const EMBEDDING_DIMENSIONS = 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentVersion(db: Database): number {
  const row = db.prepare(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
  ).get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/**
 * Detect whether the `schema_version` table exists.
 *
 * Used to distinguish a truly fresh database (no schema at all) from one
 * that has a `schema_version` row but is mid-upgrade. We read
 * `sqlite_master` directly instead of catching exceptions from the version
 * query, so actual errors during migration propagate instead of silently
 * falling through to the fresh-install path.
 */
function hasSchemaVersionTable(db: Database): boolean {
  const row = db.prepare(
    `SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_version'
       LIMIT 1`,
  ).get() as { present: number } | undefined;
  return row?.present === 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create all database tables, indexes, and record the schema version.
 *
 * Fully idempotent -- safe to call on every startup. Uses `IF NOT EXISTS`
 * for all DDL and `ON CONFLICT DO NOTHING` for the version row.
 *
 * Fresh-install detection reads `sqlite_master` directly; we do NOT use
 * throw-as-control-flow here. If a migration raises, the error propagates
 * so a partially-upgraded vault surfaces the failure instead of being
 * silently stamped at SCHEMA_VERSION.
 *
 * @param db -- better-sqlite3 Database instance.
 * @param machineId -- machine identifier for backfilling existing rows during
 *   v3->v4 and v6->v7 migrations. Defaults to `'local'` (tests, init).
 */
export function createSchema(db: Database, machineId: string = DEFAULT_MACHINE_ID): void {
  if (hasSchemaVersionTable(db)) {
    const currentVersion = getCurrentVersion(db);
    if (currentVersion === SCHEMA_VERSION) return;

    // Run pending migrations in order. Errors propagate intentionally so
    // partial upgrade failures are visible to the caller.
    for (const migration of MIGRATIONS) {
      const version = getCurrentVersion(db);
      if (version < migration.version) {
        migration.migrate(db, machineId);
      }
    }
    return;
  }

  // Fresh install: create all tables, FTS, indexes
  for (const ddl of TABLE_DDLS) { db.exec(ddl); }
  for (const ddl of FTS_TABLES) { db.exec(ddl); }
  for (const idx of SECONDARY_INDEXES) { db.exec(idx); }

  db.prepare(
    `INSERT INTO schema_version (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT (version) DO NOTHING`
  ).run(SCHEMA_VERSION, epochSeconds());
}
