import type { RelationalStore } from './adapters.js';

type Row = Record<string, unknown>;

export class RelationalSnapshotError extends Error {}
export class RelationalSnapshotTooLargeError extends RelationalSnapshotError {
  constructor(readonly bytes: number) { super(`the relational snapshot needs ${bytes} bytes`); }
}

export const MAX_RELATIONAL_SNAPSHOT_ROWS = 10_000;
export const MAX_RELATIONAL_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const JSON_ESCAPE_BYTES = 6;
const ROW_FRAME_BYTES = 24;
const NULL_FIELD_FRAME_BYTES = 8;
const OPERATOR_BACKUP = 'myco server backup --to <directory> --target <deployment-target>';

export class RelationalSnapshotAdmissionError extends RelationalSnapshotError {
  constructor(readonly rows: number, readonly conservativeBytes: number | null) {
    super(`the additive snapshot needs ${rows} rows${conservativeBytes === null ? '' : ` and at most ${conservativeBytes} conservative bytes`}; its admission limits are ${MAX_RELATIONAL_SNAPSHOT_ROWS} rows and ${MAX_RELATIONAL_SNAPSHOT_BYTES} conservative bytes. Use ${OPERATOR_BACKUP} for full operator recovery`);
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Each compound SELECT stays within the stores' term ceiling; OFFSET 0 prevents flattening its groups. */
const UNION_GROUP_TERMS = 4;
/** A JSON_SET call has one object argument and two arguments per field, within the 32-argument store ceiling. */
const JSON_SET_FIELDS_PER_CALL = 15;

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

type Admission = { admission_count: number; admission_bytes: number };

/** OCTET_LENGTH reads column byte lengths from record metadata; JSON escapes require at most six bytes per source byte. */
function conservativeSize(table: string, names: readonly string[]): string {
  const framing = ROW_FRAME_BYTES + table.length + names.reduce((bytes, name) => bytes + name.length + NULL_FIELD_FRAME_BYTES, 0);
  return `${framing} + ${names.map((name) => `${JSON_ESCAPE_BYTES} * COALESCE(octet_length("${name}"), 0)`).join(' + ')}`;
}

/** Count admission precedes payload reads; the snapshot repeats admission at its committed instant. */
export async function relationalSnapshot(db: RelationalStore, tables: readonly string[], maxBytes: number): Promise<ReadonlyMap<string, readonly Row[]>> {
  if (tables.length === 0 || !tables.every((table) => IDENTIFIER.test(table))) throw new RelationalSnapshotError('snapshot tables must be store identifiers');
  const countSql = unionGroups(tables.map((table) => `SELECT COUNT(*) AS n FROM ${table}`));
  const countStatement = `SELECT SUM(n) AS admission_count FROM (${countSql})`;
  const [countResult] = await db.batch([db.prepare(countStatement)]);
  const count = (countResult?.results[0] as { admission_count: number } | undefined)?.admission_count;
  if (typeof count !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission count');
  if (count > MAX_RELATIONAL_SNAPSHOT_ROWS) throw new RelationalSnapshotAdmissionError(count, null);
  const columns = await db.batch(tables.map((table) => db.prepare(`PRAGMA table_info(${table})`)));
  const names = tables.map((table, index) => {
    const fields = columns[index]!.results.map((column) => (column as { name: string }).name);
    if (fields.length === 0 || !fields.every((name) => IDENTIFIER.test(name))) throw new RelationalSnapshotError(`the snapshot table ${table} has no readable schema`);
    return fields;
  });
  const sizeSql = unionGroups(tables.map((table, index) => `SELECT COALESCE(SUM(${conservativeSize(table, names[index]!)}), 0) AS n FROM ${table}`));
  const admissionSql = `WITH admission_count AS MATERIALIZED (${countStatement})
    SELECT admission_count, CASE WHEN admission_count <= ${MAX_RELATIONAL_SNAPSHOT_ROWS}
      THEN (SELECT SUM(n) FROM (${sizeSql})) ELSE NULL END AS admission_bytes FROM admission_count`;
  const byteLimit = Math.min(maxBytes, MAX_RELATIONAL_SNAPSHOT_BYTES);
  const admit = (receipt: Admission | undefined) => {
    if (receipt === undefined || typeof receipt.admission_count !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission receipt');
    if (receipt.admission_count > MAX_RELATIONAL_SNAPSHOT_ROWS) throw new RelationalSnapshotAdmissionError(receipt.admission_count, null);
    if (typeof receipt.admission_bytes !== 'number') throw new RelationalSnapshotError('the snapshot returned no admission size');
    if (receipt.admission_bytes > MAX_RELATIONAL_SNAPSHOT_BYTES) throw new RelationalSnapshotAdmissionError(receipt.admission_count, receipt.admission_bytes);
    if (receipt.admission_bytes > maxBytes) throw new RelationalSnapshotTooLargeError(receipt.admission_bytes);
  };
  const [preflight] = await db.batch([db.prepare(admissionSql)]);
  admit(preflight?.results[0] as Admission | undefined);
  const selections = tables.map((table, index) =>
    `SELECT ${index} AS ordinal, rowid AS rid, json_object('t', '${table}', 'r', ${serializedRow(names[index]!)}) AS line FROM ${table}
      WHERE (SELECT admission_count <= ${MAX_RELATIONAL_SNAPSHOT_ROWS} AND admission_bytes <= ${byteLimit} FROM admission)`);
  const [result] = await db.batch([db.prepare(`WITH admission AS MATERIALIZED (${admissionSql}),
    snapshot_rows AS MATERIALIZED (${unionGroups(selections)}),
    snapshot_size AS (SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(length(CAST(line AS BLOB)) + 1), 0) AS snapshot_bytes FROM snapshot_rows)
    SELECT admission_count, admission_bytes, snapshot_count, snapshot_bytes, line FROM admission CROSS JOIN snapshot_size
    LEFT JOIN snapshot_rows ON snapshot_bytes <= ? ORDER BY ordinal, rid`).bind(byteLimit)]);
  admit(result?.results[0] as Admission | undefined);
  const rows = result?.results as Array<{ snapshot_count: number; snapshot_bytes: number; line: string | null }> | undefined;
  const measured = rows?.[0];
  if (measured === undefined) throw new RelationalSnapshotError('the snapshot returned no completeness receipt; no artifact was published');
  if (measured.snapshot_bytes > maxBytes) throw new RelationalSnapshotTooLargeError(measured.snapshot_bytes);
  const lines = rows!.filter((row) => row.line !== null);
  if (measured.snapshot_count !== lines.length) throw new RelationalSnapshotError('the snapshot is incomplete; no artifact was published');
  const snapshot = new Map<string, Row[]>(tables.map((table) => [table, []]));
  for (const row of lines) {
    const parsed = JSON.parse(row.line!) as { t: string; r: Row };
    snapshot.get(parsed.t)!.push(parsed.r);
  }
  return snapshot;
}

const SESSION_CHILDREN = ['events', 'prompt_batches', 'tool_calls', 'responses', 'plans', 'attachments', 'transcripts'];
const identity = (row: Row, key: string) => JSON.stringify([row.project_id, row[key]]);

/** Every capture row requires the session through which the Deployment reads it. */
export function assertCaptureClosure(snapshot: ReadonlyMap<string, readonly Row[]>): void {
  const sessions = new Set((snapshot.get('sessions') ?? []).map((row) => identity(row, 'session_id')));
  for (const table of SESSION_CHILDREN) {
    if ((snapshot.get(table) ?? []).some((row) => !sessions.has(identity(row, 'session_id')))) {
      throw new RelationalSnapshotError(`the snapshot of ${table} names a missing session; no artifact was published`);
    }
  }
  const transcripts = new Set((snapshot.get('transcripts') ?? []).map((row) => identity(row, 'transcript_id')));
  for (const table of ['transcript_segments', 'transcript_parser_state_chunks']) {
    if ((snapshot.get(table) ?? []).some((row) => !transcripts.has(identity(row, 'transcript_id')))) {
      throw new RelationalSnapshotError(`the snapshot of ${table} names a missing transcript; no artifact was published`);
    }
  }
}
