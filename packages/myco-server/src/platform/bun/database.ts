/**
 * Opening the self-hosted database.
 *
 * SQLite's own switches live here rather than in the entry point: they are this
 * platform's mechanism, and an entry point is wiring.
 */
import { Database } from 'bun:sqlite';
import { SERVER_SCHEMA_VERSION } from '../../constants.js';
import { readSchemaVersion } from '../../db/migrate.js';
import { sqliteRelationalStore } from './sqlite.js';
import { configureSqliteLibrary } from './sqlite-library.js';

/** Opens the database on the mounted volume with foreign keys enforced and write-ahead logging on. */
export function openDatabase(databasePath: string): Database {
  configureSqliteLibrary();
  if (!databasePath) throw new Error('a self-hosted deployment requires a database path on its mounted volume');
  // `create: false`: a mistyped or unmounted path must surface as a missing
  // database, not as a running server on an empty one it silently made.
  const sqlite = new Database(databasePath, { create: false, readwrite: true });
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');
  return sqlite;
}

/**
 * Verifies the open database carries the schema this build serves, throwing by
 * name when it does not. A server that answered requests against an unmigrated
 * volume would refuse every member with a 503 that named nothing; this fails at
 * startup instead, where an operator sees it.
 */
export async function assertSchemaCurrent(sqlite: Database): Promise<void> {
  let found: number;
  try {
    found = await readSchemaVersion(sqliteRelationalStore(sqlite));
  } catch (err) {
    throw new Error(`the database has no readable Myco schema; apply migrations before serving (${(err as Error).message})`);
  }
  if (found !== SERVER_SCHEMA_VERSION) {
    throw new Error(`the database is at schema version ${found}, and this build serves ${SERVER_SCHEMA_VERSION}; apply migrations before serving`);
  }
}
