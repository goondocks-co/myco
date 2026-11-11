/**
 * The progress an additive restore keeps for an insertion-ordered table: one artifact claims the empty table, and only
 * that artifact advances its next row, each batch recording that the rows it wrote are held exactly as the artifact
 * lists them. Also the row agreement a restore checks committed rows, and the budget estimator's restart, by.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, write, type BindValue, type Bound } from '../index.js';
import { restoredTableStatements } from './restored-columns.js';
import type { RestoreOwner } from './restore-inserts.js';

export interface RestoreProgress { artifact_hash: string; next_row: number }

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const progress = read<[table: string], RestoreProgress>({ name: 'recovery.restoreProgress', sql:
  'SELECT artifact_hash, next_row FROM backup_restore_progress WHERE table_name = ?1' });

/** Where the restore holding `table` stands, or null when none has claimed it. */
export function readRestoreProgress(db: RelationalStore, table: string): Promise<RestoreProgress | null> {
  return first(db, progress.bind(table));
}

const claims = restoredTableStatements<never, 'write'>('recovery.claimOrderedTable');

/** An empty insertion-ordered table admits one artifact; only that artifact may continue its writes. */
export async function claimRestoreTable(db: RelationalStore, table: string, hash: string): Promise<RestoreProgress | null> {
  const claim = claims(table, 'claim', name => write<BindValue[]>({ name, sql:
    `INSERT INTO backup_restore_progress (table_name, artifact_hash, next_row)
      SELECT ?1, ?2, 0 WHERE NOT EXISTS (SELECT 1 FROM ${table})
      ON CONFLICT (table_name) DO UPDATE SET artifact_hash = excluded.artifact_hash, next_row = 0
      WHERE NOT EXISTS (SELECT 1 FROM ${table})` }));
  await commit(db, claim.bind(table, hash));
  const held = await readRestoreProgress(db, table);
  return held?.artifact_hash === hash ? held : null;
}

function rowsMatchSql(table: string, columns: readonly string[], keys: readonly string[]): string {
  if (![...columns, ...keys].every(column => COLUMN.test(column)) || keys.length === 0) throw new Error(`restored ${table} rows name a column outside the store grammar`);
  const mismatch = columns.map((column) =>
    `(json_type(expected.value, '$.${column}') IS NOT NULL AND held.${column} IS NOT json_extract(expected.value, '$.${column}'))`);
  return `NOT EXISTS (SELECT 1 FROM json_each(?) AS expected
    LEFT JOIN ${table} AS held ON ${keys.map(key => `held.${key} = json_extract(expected.value, '$.${key}')`).join(' AND ')}
    WHERE held.${keys[0]} IS NULL OR ${mismatch.join(' OR ')})`;
}
const columnsOf = (rows: readonly Record<string, unknown>[]): string[] => [...new Set(rows.flatMap(Object.keys))];
const shapeOf = (columns: readonly string[], keys: readonly string[]): string => `${keys.join(',')}|${columns.join(',')}`;

const matches = restoredTableStatements<{ matches: number }, 'read'>('recovery.restoredRowsHeld');

/** Whether the destination holds every one of `rows` by id, each column it carries agreeing. */
export async function restoredRowsHeld(db: RelationalStore, table: string, rows: readonly Record<string, unknown>[]): Promise<boolean> {
  const columns = columnsOf(rows);
  const statement = matches(table, shapeOf(columns, ['id']), name => read<BindValue[], { matches: number }>({ name, sql:
    `SELECT ${rowsMatchSql(table, columns, ['id'])} AS matches` }));
  return (await first(db, statement.bind(JSON.stringify(rows))))?.matches === 1;
}

/** True while any of `rows` is missing by `keys` or differs from what the destination holds: what a guard over replaced rows reads. */
export function restoredRowsDiffer(table: string, rows: readonly Record<string, unknown>[], keys: readonly string[]): { sql: string; params: BindValue[] } {
  return { sql: `NOT (${rowsMatchSql(table, columnsOf(rows), keys)})`, params: [JSON.stringify(rows)] };
}

const advances = restoredTableStatements<{ next_row: number }, 'write'>('recovery.advanceOrderedTable');

/**
 * Moves `owner`'s progress past `chunk` to `next`, recording whether the destination holds the chunk's rows as the
 * artifact lists them; a disagreement fails the batch on the progress row's own check. No row when `owner` no longer
 * holds the table at its row.
 */
export function advanceRestoreProgress(owner: RestoreOwner, chunk: readonly Record<string, unknown>[], next: number): Bound<{ next_row: number }, 'write'> {
  const columns = columnsOf(chunk);
  const statement = advances(owner.table, shapeOf(columns, ['id']), name => write<BindValue[], { next_row: number }>({ name, sql:
    `UPDATE backup_restore_progress SET next_row = ?, verified = ${rowsMatchSql(owner.table, columns, ['id'])}
      WHERE table_name = ? AND artifact_hash = ? AND next_row = ? RETURNING next_row` }));
  return statement.bind(next, JSON.stringify(chunk), owner.table, owner.hash, owner.at);
}
