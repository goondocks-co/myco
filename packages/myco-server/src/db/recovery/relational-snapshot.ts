/**
 * The reads an additive relational snapshot is taken through: a row count, each table's columns, a conservative size,
 * and every row serialized as one line, all composed over the tables a snapshot names.
 *
 * Each composed text is one statement, named by its family and a digest of the text, so the same table set always runs
 * under the same names.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { composedStatements } from '../composed-statements.js';
import { read, readSet, rows, type BindValue } from '../index.js';

/** Each compound SELECT stays within the stores' term ceiling; OFFSET 0 prevents flattening its groups. */
const UNION_GROUP_TERMS = 4;
/** A JSON_SET call has one object argument and two arguments per field, within the 32-argument store ceiling. */
const JSON_SET_FIELDS_PER_CALL = 15;
const JSON_ESCAPE_BYTES = 6;
const ROW_FRAME_BYTES = 24;
const NULL_FIELD_FRAME_BYTES = 8;

export interface SnapshotAdmission { admission_count: number; admission_bytes: number }
export interface SnapshotLine extends SnapshotAdmission { snapshot_count: number; snapshot_bytes: number; line: string | null }

/** JSON_SET preserves NULL columns as explicit JSON nulls. */
function serializedRow(names: readonly string[]): string {
  let object = "'{}'";
  for (let start = 0; start < names.length; start += JSON_SET_FIELDS_PER_CALL) {
    const fields = names.slice(start, start + JSON_SET_FIELDS_PER_CALL).map((name) => `'$.${name}', "${name}"`).join(', ');
    object = `json_set(${object}, ${fields})`;
  }
  return object;
}

function unionGroups(selections: readonly string[]): string {
  let groups = [...selections];
  while (groups.length > UNION_GROUP_TERMS) {
    groups = Array.from({ length: Math.ceil(groups.length / UNION_GROUP_TERMS) }, (_, index) =>
      `SELECT * FROM (${groups.slice(index * UNION_GROUP_TERMS, (index + 1) * UNION_GROUP_TERMS).join(' UNION ALL ')}) LIMIT -1 OFFSET 0`)
      .map((group) => `SELECT * FROM (${group})`);
  }
  return groups.join(' UNION ALL ');
}

/** OCTET_LENGTH reads column byte lengths from record metadata; JSON escapes require at most six bytes per source byte. */
function conservativeSize(table: string, names: readonly string[]): string {
  const framing = ROW_FRAME_BYTES + table.length + names.reduce((bytes, name) => bytes + name.length + NULL_FIELD_FRAME_BYTES, 0);
  return `${framing} + ${names.map((name) => `${JSON_ESCAPE_BYTES} * COALESCE(octet_length("${name}"), 0)`).join(' + ')}`;
}

const countStatement = (tables: readonly string[]) =>
  `SELECT SUM(n) AS admission_count FROM (${unionGroups(tables.map((table) => `SELECT COUNT(*) AS n FROM ${table}`))})`;

const admissionSql = (tables: readonly string[], names: readonly (readonly string[])[], maxRows: number) => {
  const sizeSql = unionGroups(tables.map((table, index) => `SELECT COALESCE(SUM(${conservativeSize(table, names[index]!)}), 0) AS n FROM ${table}`));
  return `WITH admission_count AS MATERIALIZED (${countStatement(tables)})
    SELECT admission_count, CASE WHEN admission_count <= ${maxRows}
      THEN (SELECT SUM(n) FROM (${sizeSql})) ELSE NULL END AS admission_bytes FROM admission_count`;
};

const counts = composedStatements<{ admission_count: number }, 'read'>('recovery.snapshotCount');
const admissions = composedStatements<SnapshotAdmission, 'read'>('recovery.snapshotAdmission');
const snapshots = composedStatements<SnapshotLine, 'read'>('recovery.snapshotRows');
const columns = read<[table: string], { name: string }>({ name: 'recovery.snapshotColumns', sql:
  'SELECT name FROM pragma_table_info(?1) ORDER BY cid' });

/** How many rows the tables hold together, or undefined when the store answered no count. */
export async function snapshotRowCount(db: RelationalStore, tables: readonly string[]): Promise<number | undefined> {
  const text = countStatement(tables);
  const [row] = await rows(db, counts(text, name => read<BindValue[], { admission_count: number }>({ name, sql: text })).bind());
  return row?.admission_count;
}

/** Each table's column names in declaration order, in one read set. */
export async function snapshotColumns(db: RelationalStore, tables: readonly string[]): Promise<string[][]> {
  const answers = await readSet(db, ...tables.map((table) => columns.bind(table)));
  return answers.map((answer) => answer.map((column) => column.name));
}

/** The row count and, within `maxRows`, the conservative byte size of the tables' rows. */
export async function snapshotAdmission(db: RelationalStore, tables: readonly string[], names: readonly (readonly string[])[], maxRows: number): Promise<SnapshotAdmission | undefined> {
  const text = admissionSql(tables, names, maxRows);
  const [row] = await rows(db, admissions(text, name => read<BindValue[], SnapshotAdmission>({ name, sql: text })).bind());
  return row;
}

/**
 * Every row of the tables as one serialized line, in table then rowid order, with the admission repeated at the instant
 * the rows are read and the snapshot's own count and size. Past `maxRows` or past `byteLimit` the lines are null, and
 * the first answer still carries the measures.
 */
export async function snapshotLines(db: RelationalStore, tables: readonly string[], names: readonly (readonly string[])[], maxRows: number, byteLimit: number): Promise<SnapshotLine[]> {
  // One admission gate over every table's rows: the statement references the admission once, however many tables it reads.
  const tableRows = tables.map((table, index) =>
    `SELECT ${index} AS ordinal, rowid AS rid, json_object('t', '${table}', 'r', ${serializedRow(names[index]!)}) AS line FROM ${table}`);
  const selections = [`SELECT * FROM (${unionGroups(tableRows)})
      WHERE (SELECT admission_count <= ${maxRows} AND admission_bytes <= ?1 FROM admission)`];
  const text = `WITH admission AS MATERIALIZED (${admissionSql(tables, names, maxRows)}),
    snapshot_rows AS MATERIALIZED (${unionGroups(selections)}),
    snapshot_size AS (SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(length(CAST(line AS BLOB)) + 1), 0) AS snapshot_bytes FROM snapshot_rows)
    SELECT admission_count, admission_bytes, snapshot_count, snapshot_bytes, line FROM admission CROSS JOIN snapshot_size
    LEFT JOIN snapshot_rows ON snapshot_bytes <= ?1 ORDER BY ordinal, rid`;
  return rows(db, snapshots(text, name => read<BindValue[], SnapshotLine>({ name, sql: text })).bind(byteLimit));
}
