/**
 * What a restore reads of the destination as it writes: how many artifact rows a table already holds by key, the
 * bundle the destination holds under an artifact bundle's object key, and the removal of a restored bundle nothing uses.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { first, read, write, type BindValue, type Bound } from '../index.js';
import { bundleHeld } from '../storage/blob-held.js';
import { restoredTableStatements } from './restored-columns.js';

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const counts = restoredTableStatements<{ n: number }, 'read'>('recovery.restoreHeldByKey');

/**
 * How many of `rows` the destination's `table` holds by `keys`, each of `compared` beyond the keys also agreeing. A
 * table with no key holds none.
 */
export async function heldByKeyCount(db: RelationalStore, table: string, keys: readonly string[], compared: readonly string[], rows: readonly Record<string, unknown>[]): Promise<number> {
  if (keys.length === 0) return 0;
  if (![...keys, ...compared].every(column => COLUMN.test(column))) throw new Error(`a restored ${table} row carries a column name outside the store grammar`);
  const extra = compared.filter((column) => !keys.includes(column));
  const statement = counts(table, `${keys.join(',')}|${extra.join(',')}`, name => read<BindValue[], { n: number }>({ name, sql:
    `SELECT COUNT(*) AS n FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM ${table} t
      WHERE ${keys.map((key) => `t.${key} = json_extract(j.value, '$.${key}')`).join(' AND ')}
        ${extra.map((column) => `AND t.${column} IS json_extract(j.value, '$.${column}')`).join(' ')})` }));
  const columns = [...keys, ...extra];
  const held = await first(db, statement.bind(JSON.stringify(rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))))));
  return held?.n ?? 0;
}

const bundleByObject = read<[project: string, archive: string], Record<string, unknown>>({ name: 'recovery.heldBundle', sql:
  'SELECT * FROM archive_bundles WHERE project_id = ?1 AND archive_key = ?2' });

/** The bundle the destination holds under an artifact bundle's object key, as its own row. */
export function heldBundleByObject(db: RelationalStore, projectId: string, archiveKey: string): Promise<Record<string, unknown> | null> {
  return first(db, bundleByObject.bind(projectId, archiveKey));
}

const dropProofs = write<[project: string, archive: string, receiptSource: string, bundle: number]>({ name: 'recovery.dropUnusedBundleProofs', sql:
  `DELETE FROM registered_content_proofs WHERE project_id = ?1
    AND ((source_kind = 'bundle' AND source_id = ?2) OR (source_kind = 'receipt' AND source_id = ?3))
    AND NOT (${bundleHeld('?1', '?4')})` });
const dropBundle = write<[project: string, bundle: number], { id: number }>({ name: 'recovery.dropUnusedBundle', sql:
  `DELETE FROM archive_bundles WHERE project_id = ?1 AND id = ?2 AND NOT (${bundleHeld('?1', '?2')}) RETURNING id` });

/**
 * A restored bundle nothing uses, removed with its proofs, each only while no retained row names it. The bundle's
 * delete answers its id when it removes the bundle.
 */
export function unusedBundleRemoval(bundle: { projectId: string; id: number; archiveKey: string }): [Bound<never, 'write'>, Bound<{ id: number }, 'write'>] {
  return [
    dropProofs.bind(bundle.projectId, bundle.archiveKey, `bundle:${bundle.archiveKey}`, bundle.id),
    dropBundle.bind(bundle.projectId, bundle.id),
  ];
}
