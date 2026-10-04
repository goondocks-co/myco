import type { RelationalStore } from './adapters.js';

type Row = Record<string, unknown>;

export class RelationalSnapshotError extends Error {}
export class RelationalSnapshotTooLargeError extends RelationalSnapshotError {
  constructor(readonly bytes: number) { super(`the relational snapshot needs ${bytes} bytes`); }
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

/** One statement reads every table at one committed instant; oversized snapshots return only their measured size. */
export async function relationalSnapshot(db: RelationalStore, tables: readonly string[], maxBytes: number): Promise<ReadonlyMap<string, readonly Row[]>> {
  if (tables.length === 0 || !tables.every((table) => IDENTIFIER.test(table))) throw new RelationalSnapshotError('snapshot tables must be store identifiers');
  const columns = await db.batch(tables.map((table) => db.prepare(`PRAGMA table_info(${table})`)));
  const selections = tables.map((table, index) => {
    const names = columns[index]!.results.map((column) => (column as { name: string }).name);
    if (names.length === 0 || !names.every((name) => IDENTIFIER.test(name))) throw new RelationalSnapshotError(`the snapshot table ${table} has no readable schema`);
    return `SELECT ${index} AS ordinal, rowid AS rid, json_object('t', '${table}', 'r', ${serializedRow(names)}) AS line FROM ${table}`;
  });
  let groups = selections;
  while (groups.length > UNION_GROUP_TERMS) {
    groups = Array.from({ length: Math.ceil(groups.length / UNION_GROUP_TERMS) }, (_, index) =>
      `SELECT * FROM (${groups.slice(index * UNION_GROUP_TERMS, (index + 1) * UNION_GROUP_TERMS).join(' UNION ALL ')}) LIMIT -1 OFFSET 0`)
      .map((group) => `SELECT * FROM (${group})`);
  }
  const union = groups.join(' UNION ALL ');
  const [result] = await db.batch([db.prepare(`WITH snapshot_rows AS MATERIALIZED (${union}),
    snapshot_size AS (SELECT COUNT(*) AS snapshot_count, COALESCE(SUM(length(CAST(line AS BLOB)) + 1), 0) AS snapshot_bytes FROM snapshot_rows)
    SELECT snapshot_count, snapshot_bytes, line FROM snapshot_size
    LEFT JOIN snapshot_rows ON snapshot_bytes <= ? ORDER BY ordinal, rid`).bind(maxBytes)]);
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
