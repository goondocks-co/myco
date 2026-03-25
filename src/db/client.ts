/**
 * SQLite client -- connection lifecycle management.
 *
 * Provides init/get/close for a singleton better-sqlite3 instance.
 * The instance is synchronous and reused for the lifetime of the process.
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';

const NOT_INITIALIZED_MSG = 'Database not initialized -- call initDatabase() first';

/** Standard filename for SQLite data within a vault. */
export const SQLITE_DB_FILE = 'myco.db';

/** Singleton Database instance. */
let instance: DatabaseType | null = null;

/**
 * Initialize (or return existing) SQLite instance with WAL mode.
 *
 * @param dbPath -- filesystem path for the database file. Omit for in-memory.
 * @returns the Database instance.
 */
export function initDatabase(dbPath?: string): DatabaseType {
  if (instance) return instance;

  instance = new Database(dbPath ?? ':memory:');

  // Performance and safety PRAGMAs
  instance.pragma('journal_mode = WAL');
  instance.pragma('foreign_keys = ON');
  instance.pragma('busy_timeout = 5000');
  instance.pragma('cache_size = -64000');
  instance.pragma('temp_store = MEMORY');

  return instance;
}

/**
 * Return the current Database instance.
 *
 * @throws if `initDatabase()` has not been called.
 */
export function getDatabase(): DatabaseType {
  if (!instance) throw new Error(NOT_INITIALIZED_MSG);
  return instance;
}

/**
 * Close the Database instance and reset the singleton.
 *
 * Safe to call when already closed or never initialized.
 */
export function closeDatabase(): void {
  if (!instance) return;
  instance.close();
  instance = null;
}

/**
 * Open a read-only connection to a vault database.
 *
 * Used by CLI commands for direct reads without the daemon.
 * Caller is responsible for closing the returned instance.
 */
export function openReadonly(dbPath: string): DatabaseType {
  const db = new Database(dbPath, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Build the standard database path for a vault directory.
 */
export function vaultDbPath(vaultDir: string): string {
  return path.join(vaultDir, SQLITE_DB_FILE);
}
