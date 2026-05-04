/**
 * SQLite client -- connection lifecycle management.
 *
 * Provides init/get/close for a singleton bun:sqlite instance.
 * Native-dep resolution (custom libsqlite3 for extension loading) happens
 * lazily at first initDatabase / openReadonly call.
 */

import { Database } from 'bun:sqlite';
import path from 'node:path';
import { resolveDevNativeDeps } from '../runtime/native-deps.js';

const NOT_INITIALIZED_MSG = 'Database not initialized -- call initDatabase() first';

/** Standard filename for SQLite data within a vault. */
export const SQLITE_DB_FILE = 'myco.db';

/** Singleton Database instance. */
let instance: Database | null = null;

function ensureNativeDepsResolved(): void {
  resolveDevNativeDeps();
}

function configureDatabase(db: Database): Database {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA cache_size = -64000');
  db.run('PRAGMA temp_store = MEMORY');
  return db;
}

/** Re-export for callers that need the concrete type. */
export type { Database };

/**
 * Initialize (or return existing) SQLite instance with WAL mode.
 */
export function initDatabase(dbPath?: string): Database {
  if (instance) return instance;
  instance = openDatabase(dbPath);
  return instance;
}

/**
 * Open an independent SQLite connection with the same runtime pragmas as the
 * process-wide singleton.
 */
export function openDatabase(dbPath?: string): Database {
  ensureNativeDepsResolved();
  return configureDatabase(new Database(dbPath ?? ':memory:'));
}

/**
 * Return the current Database instance.
 *
 * @throws if `initDatabase()` has not been called.
 */
export function getDatabase(): Database {
  if (!instance) throw new Error(NOT_INITIALIZED_MSG);
  return instance;
}

/**
 * Close the Database instance and reset the singleton.
 */
export function closeDatabase(): void {
  if (!instance) return;
  instance.close();
  instance = null;
}

/**
 * Open a read-only connection to a vault database.
 */
export function openReadonly(dbPath: string): Database {
  ensureNativeDepsResolved();
  const db = new Database(dbPath, { readonly: true });
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}

/**
 * Build the standard database path for a vault directory.
 */
export function vaultDbPath(vaultDir: string): string {
  return path.join(vaultDir, SQLITE_DB_FILE);
}

/**
 * Read a single-value PRAGMA as better-sqlite3's pragma(name, { simple: true }) did.
 * Returns the first column of the first row.
 */
export function simplePragma(db: Database, name: string): string | number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  if (!row) return '';
  const value = Object.values(row)[0];
  return (value as string | number) ?? '';
}

/**
 * Read the affected-row count of the MOST RECENT statement.
 *
 * bun:sqlite's `info.changes` from `.run()` includes trigger-induced writes,
 * which matches SQL's `total_changes()`. better-sqlite3 returned the outer
 * statement's affected rows only (SQL's `changes()`). Callers that need the
 * outer count — typically after DELETEs that fire FTS-sync triggers — must
 * use this helper immediately after `.run()` on the same connection.
 */
export function changesSince(db: Database): number {
  const row = db.prepare('SELECT changes() AS c').get() as { c: number };
  return row.c;
}
