/** What creating a backup reads besides the rows it carries: which of its tables the store holds, and the newest backup. */
import type { RelationalStore } from '../../core/adapters.js';
import { first, rows, read } from '../index.js';

const tablesHeld = read<[tables: string], { name: string }>({ name: 'backup.tablesHeld', sql:
  `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (SELECT value FROM json_each(?1))` });

/** Those of `tables` the store holds; a store at an older schema holds fewer. */
export async function heldTables(db: RelationalStore, tables: readonly string[]): Promise<Set<string>> {
  return new Set((await rows(db, tablesHeld.bind(JSON.stringify(tables)))).map((row) => row.name));
}

const newest = read<[], { at: number | null }>({ name: 'backup.newestCreatedAt', sql: 'SELECT MAX(created_at) AS at FROM backups' });

/** The instant of the newest backup the index records, or null when it records none. */
export async function latestBackupAt(db: RelationalStore): Promise<number | null> {
  return (await first(db, newest.bind()))?.at ?? null;
}
