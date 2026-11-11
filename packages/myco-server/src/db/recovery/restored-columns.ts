/**
 * Statements over the columns a restored row carries.
 *
 * A backup line names its own columns, and an artifact from an older release can carry fewer than this schema holds, so
 * a restore insert lists exactly the columns the row has and leaves the rest to their defaults. Each distinct column
 * list is one statement shape, defined the first time a restore asks for it and named by its table and a digest of the
 * list.
 */
import type { BindValue, Statement } from '../index.js';
import { shapedStatements } from '../runs/statement-shapes.js';

/** A row's values in column order, with an absent value bound as null. */
export const restoredValues = (row: Readonly<Record<string, unknown>>, columns: readonly string[]): BindValue[] =>
  columns.map(column => (row[column] ?? null) as BindValue);

/** A digest of a column list that can stand in a statement name: FNV-1a over the list, in base 36. */
function columnsDigest(columns: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(columns.join(','))) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(36);
}

/** One definition per column list of `family`, made the first time that list is asked for. */
export function restoredColumnStatements<Row, Kind extends 'read' | 'write'>(family: string): (
  columns: readonly string[], define: (name: string, columns: readonly string[]) => Statement<BindValue[], Row, Kind>,
) => Statement<BindValue[], Row, Kind> {
  const shaped = shapedStatements<Statement<BindValue[], Row, Kind>>();
  return (columns, define) => shaped(columns.join(','), () => define(`${family}K${columnsDigest(columns)}`, columns));
}
