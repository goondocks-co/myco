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

/** Re-export for callers that need the concrete type. */
export type { Database };

/**
 * Initialize (or return existing) SQLite instance with WAL mode.
 */
export function initDatabase(dbPath?: string): Database {
  if (instance) return instance;
  ensureNativeDepsResolved();

  instance = new Database(dbPath ?? ':memory:');

  instance.run('PRAGMA journal_mode = WAL');
  instance.run('PRAGMA foreign_keys = ON');
  instance.run('PRAGMA busy_timeout = 5000');
  instance.run('PRAGMA cache_size = -64000');
  instance.run('PRAGMA temp_store = MEMORY');

  return instance;
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
