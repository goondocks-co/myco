import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

/** The tables a quick check covers: every ordinary table, without the engine's and platform's own. */
export const CHECKED_TABLES_SQL = `SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'
  AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name`;
/** One table's quick check. */
export const quickCheckSql = (table: string): string => `PRAGMA quick_check('${table.replaceAll("'", "''")}')`;


const tables = read<[], { name: string }>({ name: 'meta.checkedTables', sql: CHECKED_TABLES_SQL });
const optimize = write<[], unknown>({ name: 'meta.optimizeStore', sql: 'PRAGMA optimize' });
const quick = read<[table: string], { quick_check: string }>({ name: 'meta.quickCheckTable', sql:
  'SELECT quick_check FROM pragma_quick_check(?)' });
const foreign = write<[], { table: string; rowid: number | null; parent: string }>({ name: 'meta.foreignKeyCheck', sql: 'PRAGMA foreign_key_check' });
const sizeOf = (meta: object) => (meta as { size_after?: number }).size_after;
export async function checkedTables(db: RelationalStore) {
  const [rows] = await readSet(db,tables.bind()); return rows.map(row=>row.name);
}
export async function optimizeStore(db: RelationalStore) {
  const [result] = await commit(db,optimize.bind()); return sizeOf(result.meta);
}
export async function checkStoreTables(db: RelationalStore, tables: readonly string[]) {
  const results = await readSet(db,...tables.map(table=>quick.bind(table)));
  return results.flatMap(rows=>rows.map(row=>row.quick_check)).filter(text=>text!=='ok');
}
export async function checkForeignKeys(db: RelationalStore) {
  const [result] = await commit(db,foreign.bind());
  return { size: sizeOf(result.meta),
    findings: result.results.map(row=>`foreign key: ${row.table} row ${row.rowid} names a missing ${row.parent}`) };
}
