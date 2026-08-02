/**
 * Database introspection and maintenance queries.
 *
 * Read side: file stats, schema/index metadata, log lookup.
 * Write side: VACUUM, ANALYZE, REINDEX, integrity_check, wal_checkpoint, FTS optimize.
 */

import fs from 'node:fs';
import { getDatabase, simplePragma } from '@myco/db/client.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseFileStats {
  path: string;
  size_bytes: number;
  wal_size_bytes: number;
  page_size: number;
  page_count: number;
  freelist_count: number;
  fragmentation_pct: number;
}

export interface TableBreakdownRow {
  name: string;
  rows: number;
  index_count: number;
  is_fts: boolean;
}

export interface IndexInfo {
  name: string;
  table: string;
  type: 'btree' | 'auto';
  sql: string | null;
}

export interface SchemaInfo {
  /**
   * The DATABASE's stamped schema version (its newest `schema_version`
   * row) — what the file on disk actually is, not what this binary would
   * migrate it to. Falls back to the binary's constant only when the
   * stamp is unreadable.
   */
  version: number;
  /** The running binary's compiled SCHEMA_VERSION. */
  binary_version: number;
  journal_mode: string;
  foreign_keys: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function pragmaScalar<T>(name: string): T {
  const db = getDatabase();
  return simplePragma(db, name) as T;
}

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function getDatabaseFileStats(dbPath: string): DatabaseFileStats {
  const size_bytes = safeFileSize(dbPath);
  const wal_size_bytes = safeFileSize(dbPath + '-wal');

  const page_size = Number(pragmaScalar<number>('page_size'));
  const page_count = Number(pragmaScalar<number>('page_count'));
  const freelist_count = Number(pragmaScalar<number>('freelist_count'));
  const fragmentation_pct = page_count > 0 ? (freelist_count / page_count) * 100 : 0;

  return {
    path: dbPath,
    size_bytes,
    wal_size_bytes,
    page_size,
    page_count,
    freelist_count,
    fragmentation_pct,
  };
}

/**
 * Double-quote-escape a SQL identifier (table/column name). SQLite accepts
 * `""` as an escaped double-quote inside a quoted identifier. Names that
 * come from `sqlite_master` never contain double quotes in practice, but
 * escape defensively so the helper is safe for any caller.
 */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function getTablesBreakdown(): TableBreakdownRow[] {
  const db = getDatabase();

  // List all user tables (exclude sqlite_* internal)
  const tableRows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string; sql: string | null }>;

  // FTS5 shadow tables (e.g. sessions_fts_data, sessions_fts_idx, sessions_fts_docsize,
  // sessions_fts_config) are auto-created by SQLite with DDL that single-quotes the name
  // (CREATE TABLE 'sessions_fts_data' ...). User-created tables never quote with single
  // quotes, so filter by that marker to hide them from the UI breakdown.
  const userTableRows = tableRows.filter((row) => !(row.sql ?? '').startsWith("CREATE TABLE '"));

  // Index counts grouped by table (single query covering all tables).
  const indexCountRows = db.prepare(
    "SELECT tbl_name, COUNT(*) AS cnt FROM sqlite_master WHERE type='index' GROUP BY tbl_name",
  ).all() as Array<{ tbl_name: string; cnt: number }>;
  const indexCountByTable = new Map(indexCountRows.map((r) => [r.tbl_name, Number(r.cnt)]));

  // Batch all per-table COUNT(*) into one UNION ALL query instead of N round-trips.
  // SAFE: table names come from sqlite_master, not user input. Names are
  // double-quoted for the FROM clause and positional parameters are used for
  // the table-name output column so the query can be read back by index.
  const countsByTable = new Map<string, number>();
  if (userTableRows.length > 0) {
    const unionSql = userTableRows
      .map((_, i) => `SELECT ? AS t, COUNT(*) AS c FROM ${quoteIdent(userTableRows[i].name)}`)
      .join(' UNION ALL ');
    const params = userTableRows.map((row) => row.name);
    try {
      const rows = db.prepare(unionSql).all(...params) as Array<{ t: string; c: number }>;
      for (const r of rows) {
        countsByTable.set(r.t, Number(r.c ?? 0));
      }
    } catch {
      // Fallback: if the batched query fails for any reason (e.g. one of the
      // tables was dropped mid-query), fall back to per-table counts so the
      // breakdown still reports something reasonable. Rare in practice.
      for (const row of userTableRows) {
        try {
          const r = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(row.name)}`).get() as { c: number };
          countsByTable.set(row.name, Number(r.c ?? 0));
        } catch {
          countsByTable.set(row.name, 0);
        }
      }
    }
  }

  return userTableRows.map((row) => ({
    name: row.name,
    rows: countsByTable.get(row.name) ?? 0,
    index_count: indexCountByTable.get(row.name) ?? 0,
    is_fts: (row.sql ?? '').toLowerCase().includes('fts5'),
  }));
}

export function getIndexesList(): IndexInfo[] {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' ORDER BY tbl_name, name",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;

  return rows.map((r) => {
    const type: 'btree' | 'auto' = r.name.startsWith('sqlite_autoindex_') ? 'auto' : 'btree';
    return {
      name: r.name,
      table: r.tbl_name,
      type,
      sql: r.sql,
    };
  });
}

export function getSchemaInfo(): SchemaInfo {
  const journal_mode = String(pragmaScalar<string>('journal_mode'));
  const foreign_keys_raw = pragmaScalar<number | string>('foreign_keys');
  const foreign_keys = Number(foreign_keys_raw) === 1;
  const stamped = (() => {
    try {
      const row = getDatabase()
        .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
        .get() as { version: number } | undefined;
      return typeof row?.version === 'number' ? row.version : null;
    } catch {
      return null;
    }
  })();
  return {
    version: stamped ?? SCHEMA_VERSION,
    binary_version: SCHEMA_VERSION,
    journal_mode,
    foreign_keys,
  };
}

export function getLastDatabaseLogTimestamp(kind: string): number | null {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT timestamp FROM log_entries WHERE kind = ? ORDER BY id DESC LIMIT 1',
  ).get(kind) as { timestamp: string } | undefined;
  if (!row) return null;
  const t = new Date(row.timestamp).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Batched variant: look up the most recent `timestamp` for each of the given
 * kinds in a single query. Missing kinds map to `null`. Used by
 * `DatabaseMaintenanceManager.getDetails()` to fetch optimize/vacuum/integrity
 * timestamps in one round-trip instead of N.
 */
export function getLastDatabaseLogTimestamps(kinds: string[]): Map<string, number | null> {
  const result = new Map<string, number | null>();
  for (const k of kinds) result.set(k, null);
  if (kinds.length === 0) return result;

  const db = getDatabase();
  const placeholders = kinds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT kind, MAX(timestamp) AS latest FROM log_entries WHERE kind IN (${placeholders}) GROUP BY kind`,
  ).all(...kinds) as Array<{ kind: string; latest: string | null }>;

  for (const row of rows) {
    if (!row.latest) continue;
    const t = new Date(row.latest).getTime();
    result.set(row.kind, Number.isFinite(t) ? t : null);
  }
  return result;
}

// -----------------------------------------------------------------------------
// Maintenance operations
//
// Convention: imperative commands use the `run*` prefix to distinguish them
// from the CRUD-style queries above (`getX`, `listX`). These functions execute
// SQL commands that modify database state or schema metadata rather than
// returning rows from user tables.
// -----------------------------------------------------------------------------

export interface IntegrityCheckResult {
  status: 'ok' | 'issues';
  issues: string[];
}

export interface ForeignKeyViolation {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

export interface WalCheckpointResult {
  busy: number; // 0 = succeeded, 1 = blocked by reader
  log: number; // total WAL frames at start
  checkpointed: number; // frames actually checkpointed
}

export function runVacuum(): void {
  const db = getDatabase();
  db.exec('VACUUM');
}

export function runAnalyze(): void {
  const db = getDatabase();
  db.exec('ANALYZE');
}

export function runReindex(): void {
  const db = getDatabase();
  db.exec('REINDEX');
}

export function runIntegrityCheck(): IntegrityCheckResult {
  const db = getDatabase();
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  const messages = rows.map((r) => r.integrity_check);
  const ok = messages.length === 1 && messages[0] === 'ok';
  return {
    status: ok ? 'ok' : 'issues',
    issues: ok ? [] : messages,
  };
}

export function runForeignKeyCheck(): ForeignKeyViolation[] {
  const db = getDatabase();
  const rows = db.prepare('PRAGMA foreign_key_check').all() as Array<{
    table: string;
    rowid: number;
    parent: string;
    fkid: number;
  }>;
  return rows;
}

export function runWalCheckpointTruncate(): WalCheckpointResult {
  const db = getDatabase();
  const rows = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all() as Array<{
    busy: number;
    log: number;
    checkpointed: number;
  }>;
  const row = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
  return {
    busy: Number(row.busy),
    log: Number(row.log),
    checkpointed: Number(row.checkpointed),
  };
}

export function runPragmaOptimize(): void {
  const db = getDatabase();
  db.run('PRAGMA optimize');
}

const FTS_TABLE_PATTERN = /^[a-z_][a-z0-9_]*_fts$/;

export function runFtsOptimize(ftsTableName: string): void {
  // Defense in depth: validate the table name against an allowlist regex AND
  // verify it actually exists as an FTS5 virtual table in sqlite_master before
  // building the SQL string. The name is never user-supplied — it comes from
  // listFtsTableNames() — but the check protects against future regressions.
  if (!FTS_TABLE_PATTERN.test(ftsTableName)) {
    throw new Error('Invalid FTS5 table name: ' + ftsTableName);
  }
  const db = getDatabase();
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(ftsTableName) as { sql: string | null } | undefined;
  if (!row || !(row.sql ?? '').toLowerCase().includes('fts5')) {
    throw new Error('Not an FTS5 table: ' + ftsTableName);
  }
  // Build the optimize statement using string concatenation; FTS5 virtual
  // tables require the table name to appear both as the target and as the
  // first column reference. Parameter binding does not work for table names.
  const quoted = '"' + ftsTableName + '"';
  const optimizeSql = 'INSERT INTO ' + quoted + '(' + quoted + ") VALUES ('optimize')";
  db.prepare(optimizeSql).run();
}

export function listFtsTableNames(): string[] {
  const db = getDatabase();
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%fts5%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name).filter((name) => FTS_TABLE_PATTERN.test(name));
}
