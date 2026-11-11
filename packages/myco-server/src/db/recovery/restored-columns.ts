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

/** The only shape a restored table name may take before it names a statement. */
const RESTORED_TABLE = /^[a-z][a-z0-9_]*$/;
const camel = (table: string): string => table.split('_').filter(Boolean).map(part => part[0]!.toUpperCase() + part.slice(1)).join('');

/**
 * One family per table a restore writes or counts, named by `prefix` and the table in camel case, and within it one
 * definition per shape the caller names: the columns, keys or variant the statement's text follows from.
 */
export function restoredTableStatements<Row, Kind extends 'read' | 'write'>(prefix: string): (
  table: string, shape: string, define: (name: string) => Statement<BindValue[], Row, Kind>,
) => Statement<BindValue[], Row, Kind> {
  const families = new Map<string, ReturnType<typeof composedStatements<Row, Kind>>>();
  return (table, shape, define) => {
    if (!RESTORED_TABLE.test(table)) throw new Error(`restore table ${table} is outside the store grammar`);
    let family = families.get(table);
    if (family === undefined) {
      family = composedStatements<Row, Kind>(`${prefix}${camel(table)}`);
      families.set(table, family);
    }
    return family(shape, define);
  };
}
