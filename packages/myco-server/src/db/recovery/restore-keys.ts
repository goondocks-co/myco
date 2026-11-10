import type { RelationalStore } from '../../core/adapters.js';
import { read, rows } from '../index.js';

const primaryKey = read<[table: string], { name: string }>({ name: 'restore.tableKey', sql:
  'SELECT name FROM pragma_table_info(?1) WHERE pk>0 ORDER BY pk' });

/** The columns of a table's primary key, in key order: what a restore counts the artifact rows a table holds by. */
export async function restoreTableKey(db: RelationalStore, table: string): Promise<string[]> {
  return (await rows(db, primaryKey.bind(table))).map((row) => row.name);
}
