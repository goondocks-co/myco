/**
 * SQLite client -- connection lifecycle management.
 *
 * Provides init/get/close for a singleton bun:sqlite instance.
 * Native-dep resolution (custom libsqlite3 for extension loading) happens
 * lazily at first initDatabase / openReadonly call.
 */

import { Database } from 'bun:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { resolveDevNativeDeps } from '../runtime/native-deps.js';
import { resolveGrovesDir, groveIdFromDbPath } from '../grove/paths.js';

const NOT_INITIALIZED_MSG = 'Database not initialized -- call initDatabase() first';

/** Standard filename for SQLite data within a vault. */
export const SQLITE_DB_FILE = 'myco.db';

/** Singleton Database instance. */
let instance: Database | null = null;
const scopedDatabase = new AsyncLocalStorage<Database>();

/**
 * Process-scoped declaration of which service dir owns this daemon.
 * Set once at daemon startup via `setOwnedServiceDirForCurrentProcess`.
 * When null, `assertOwnsDatabase` is a no-op (tests, one-shot scripts).
 */
let ownedServiceDir: { stateDir: string; mycoHome: string } | null = null;

/**
 * Declare that the current process is a daemon whose state dir is
 * `stateDir` (an absolute path such as `~/.myco/service`), operating
 * within `mycoHome`. Call once at daemon startup before any Grove DB
 * is opened. Subsequent calls overwrite the previous value.
 */
export function setOwnedServiceDirForCurrentProcess(stateDir: string, mycoHome: string): void {
  ownedServiceDir = { stateDir, mycoHome };
}

/**
 * Clear the process-scoped ownership declaration. After this call
 * `withDatabase` skips the ownership check. Intended for tests that
 * need to opt out of ownership enforcement.
 */
export function clearOwnedServiceDirForCurrentProcess(): void {
  ownedServiceDir = null;
}

/**
 * Throw when `databasePath` is a Grove DB that falls outside the current
 * daemon's groves directory. No-op when no owner is declared.
 *
 * Non-grove DBs (:memory:, phantom bootstrap, fixtures) pass unconditionally
 * so test and one-shot paths are never blocked.
 */
function assertOwnsDatabase(databasePath: string): void {
  if (!ownedServiceDir) return;
  // Non-grove DBs (:memory:, phantom bootstrap, fixtures) are always allowed.
  if (groveIdFromDbPath(databasePath) === null) return;
  const grovesDir = path.resolve(resolveGrovesDir(ownedServiceDir.mycoHome));
  const resolved = path.resolve(databasePath);
  if (resolved !== grovesDir && !resolved.startsWith(grovesDir + path.sep)) {
    throw new Error(
      `Daemon at home ${ownedServiceDir.mycoHome} attempted to open a Grove database `
      + `outside its groves directory: ${databasePath}. Cross-home Grove access is forbidden.`,
    );
  }
}

function ensureNativeDepsResolved(): void {
  resolveDevNativeDeps();
}

function configureDatabase(db: Database): Database {
  const currentMode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined)?.journal_mode;
  if (currentMode?.toLowerCase() !== 'wal') {
    // WAL switch needs an EXCLUSIVE lock and the WAL/SHM infrastructure. On
    // Linux that initialization can stall when the file was just replaced
    // Bound the wait to 200ms so the
    // configure step can't dominate a test's 5s budget; if we can't switch,
    // run in whatever mode the file is in. The daemon's primary open at
    // startup sets WAL once for its long-lived connection.
    db.run('PRAGMA busy_timeout = 200');
    try {
      db.run('PRAGMA journal_mode = WAL');
    } catch {
      // Keep the existing journal mode.
    }
  }
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA foreign_keys = ON');
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
 * Run work against an explicit Database connection. Query helpers that call
 * `getDatabase()` inside the callback see this scoped connection instead of
 * the process-wide singleton.
 *
 * When a process-scoped daemon ownership is declared (via
 * `setOwnedServiceDirForCurrentProcess`), asserts that the DB's Grove is
 * owned by the current daemon before running `fn`. Throws on mismatch to
 * prevent cross-Grove access from code paths that bypass `forEachGrove`.
 */
export function withDatabase<T>(db: Database, fn: () => T): T {
  assertOwnsDatabase(db.filename);
  return scopedDatabase.run(db, fn);
}

/**
 * Return the current Database instance.
 *
 * @throws if `initDatabase()` has not been called.
 */
export function getDatabase(): Database {
  const scoped = scopedDatabase.getStore();
  if (scoped) return scoped;
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

/**
 * True when a thrown error is a SQLite UNIQUE-constraint violation. Matches on
 * the extended result code (`err.code` starts with `SQLITE_CONSTRAINT`) and the
 * `UNIQUE` marker in `err.message`; works for better-sqlite3 and bun:sqlite.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: string }).code ?? '';
  const message = (err as { message?: string }).message ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') && message.includes('UNIQUE');
}
