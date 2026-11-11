/**
 * Statements over the columns a restored row carries.
 *
 * A backup line names its own columns, and an artifact from an older release can carry fewer than this schema holds, so
 * a restore insert lists exactly the columns the row has and leaves the rest to their defaults. Each distinct column
 * list is one statement shape, defined the first time a restore asks for it and named by its family and a digest of the
 * list.
 */
import { composedStatements } from '../composed-statements.js';
import type { BindValue, Statement } from '../index.js';

/** A row's values in column order, with an absent value bound as null. */
export const restoredValues = (row: Readonly<Record<string, unknown>>, columns: readonly string[]): BindValue[] =>
  columns.map(column => (row[column] ?? null) as BindValue);

/** One definition per column list of `family`, made the first time that list is asked for. */
export function restoredColumnStatements<Row, Kind extends 'read' | 'write'>(family: string): (
  columns: readonly string[], define: (name: string, columns: readonly string[]) => Statement<BindValue[], Row, Kind>,
) => Statement<BindValue[], Row, Kind> {
  const shaped = composedStatements<Row, Kind>(family);
  return (columns, define) => shaped(columns.join(','), name => define(name, columns));
}
