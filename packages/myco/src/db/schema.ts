/**
 * SQLite database schema -- all capture, intelligence, and agent state tables.
 *
 * Uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` throughout
 * for idempotency. Running `createSchema()` multiple times is always safe.
 *
 * Timestamp convention: all timestamps are INTEGER (Unix epoch seconds).
 * Content hashing: all `content_hash` columns are TEXT. Project-scoped
 * uniqueness, where required, is enforced by indexes in schema-ddl.ts.
 * Embedding dimensions: 1024 (bge-m3 default) -- used by external sqlite-vec store.
 *
 * Vector columns live in a separate sqlite-vec virtual table, not inline.
 * Tables that participate in vector search carry an `embedded INTEGER DEFAULT 0`
 * flag so the embedder knows which rows still need vectors.
 */

import type { Database } from 'bun:sqlite';
import { epochSeconds, DEFAULT_MACHINE_ID } from '@myco/constants.js';
import { TABLE_DDLS, FTS_TABLES, SECONDARY_INDEXES, TEAM_DELETE_TRIGGERS } from './schema-ddl.js';
import { MIGRATIONS } from './migrations.js';

/** Current schema version -- fresh start for the SQLite era. */
export const SCHEMA_VERSION = 51;

// Re-export for backwards compat (other modules import from schema.ts)
export { DEFAULT_MACHINE_ID };

/** Embedding vector dimensions (bge-m3 default). */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Row shape for the `canopy_entries` table — project-scoped source file index
 * that backs Canopy code intelligence. Mechanical fields (hash, size, token
 * estimate, language, exports, imports, top_comment) are maintained by the
 * scanner. `llm_description` is an optional override populated by the Tier 2
 * `canopy-describe` task.
 */
export interface CanopyEntry {
  project_id: string;
  machine_id: string;
  path: string;
  content_hash: string;
  size_bytes: number;
  token_estimate: number;
  line_count: number;
  language: string | null;
  exports_json: string | null; // JSON array
  imports_json: string | null; // JSON array
  top_comment: string | null;
  mechanical_updated_at: number; // epoch seconds
  llm_description: string | null;
  llm_updated_at: number | null;
  embedded: number;
}

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
    if (currentVersion === SCHEMA_VERSION) {
      reapplyCurrentSchemaDdl(db);
      return;
    }

    // Run pending migrations in order. Errors propagate intentionally so
    // partial upgrade failures are visible to the caller.
    for (const migration of MIGRATIONS) {
      const version = getCurrentVersion(db);
      if (version < migration.version) {
        migration.migrate(db, machineId);
      }
    }
    reapplyCurrentSchemaDdl(db);
    return;
  }

  // Fresh install: create all tables, FTS, indexes, and team-sync triggers
  for (const ddl of TABLE_DDLS) { db.exec(ddl); }
  for (const ddl of FTS_TABLES) { db.exec(ddl); }
  for (const idx of SECONDARY_INDEXES) { db.exec(idx); }
  for (const trg of TEAM_DELETE_TRIGGERS) { db.exec(trg); }

  db.prepare(
    `INSERT INTO schema_version (version, applied_at)
     VALUES (?, ?)
     ON CONFLICT (version) DO NOTHING`
  ).run(SCHEMA_VERSION, epochSeconds());
}

// ---------------------------------------------------------------------------
// Schema-drift reconciliation
//
// createSchema installs everything on fresh install and each migration
// adds its own delta, but existing DBs at the current schema version
// skip all that — so if any schema object goes missing after the fact
// (restore from a partial dump, manual DROP, an aborted beta build), the
// version gate lets the drift ride until somebody notices the symptom.
// Observed 2026-04: a vault at v21 had the log_entries FTS sync triggers
// silently dropped, so 141k log entries piled up with an empty FTS index
// and search returned zero hits.
//
// Rather than proliferate one reconcile-X helper per schema-object class
// (triggers, indexes, tables, FTS virtual tables), this reapplies ALL
// current-schema DDL on every createSchema() call. Every CREATE uses
// IF NOT EXISTS, so replay is idempotent and costs microseconds. The
// only non-DDL step is rebuilding an FTS index when its sync trigger
// was just reinstalled — the DDL reinstalls the trigger but doesn't
// repopulate writes it missed while absent.
//
// Known gap: column drift (someone dropping a column) is not covered —
// SQLite's ALTER TABLE ADD COLUMN isn't IF NOT EXISTS-aware, and today's
// migrations don't re-run past ALTERs either. We haven't seen this in
// the wild; defer until we do.
// ---------------------------------------------------------------------------

interface FtsTriggerGroup {
  ftsTable: string;
  baseTable: string;
  triggers: readonly string[];
}

const FTS_TRIGGER_GROUPS: readonly FtsTriggerGroup[] = [
  { ftsTable: 'log_entries_fts',    baseTable: 'log_entries',    triggers: ['log_entries_ai', 'log_entries_ad'] },
  { ftsTable: 'prompt_batches_fts', baseTable: 'prompt_batches', triggers: ['prompt_batches_fts_ai', 'prompt_batches_fts_au', 'prompt_batches_fts_ad'] },
  { ftsTable: 'activities_fts',     baseTable: 'activities',     triggers: ['activities_fts_ai', 'activities_fts_au', 'activities_fts_ad'] },
  { ftsTable: 'spores_fts',         baseTable: 'spores',         triggers: ['spores_fts_ai', 'spores_fts_au', 'spores_fts_ad'] },
  { ftsTable: 'sessions_fts',       baseTable: 'sessions',       triggers: ['sessions_fts_ai', 'sessions_fts_au', 'sessions_fts_ad'] },
];

function reapplyCurrentSchemaDdl(db: Database): void {
  const triggersBefore = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );

  for (const ddl of TABLE_DDLS) { db.exec(ddl); }
  for (const ddl of FTS_TABLES) { db.exec(ddl); }
  for (const idx of SECONDARY_INDEXES) { db.exec(idx); }
  for (const trg of TEAM_DELETE_TRIGGERS) { db.exec(trg); }

  let rebuiltAny = false;
  for (const group of FTS_TRIGGER_GROUPS) {
    const wasMissing = group.triggers.some((name) => !triggersBefore.has(name));
    if (!wasMissing) continue;
    const baseCount = (db.prepare(`SELECT COUNT(*) AS n FROM ${group.baseTable}`).get() as { n: number }).n;
    if (baseCount === 0) continue;
    db.prepare(`INSERT INTO ${group.ftsTable}(${group.ftsTable}) VALUES('rebuild')`).run();
    rebuiltAny = true;
  }

  if (rebuiltAny) {
    process.stderr.write('[schema] Rebuilt one or more FTS indexes after detecting missing sync triggers\n');
  }
}
