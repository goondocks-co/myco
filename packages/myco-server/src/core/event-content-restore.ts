import type { PreparedStatement, RelationalStore } from './adapters.js';
import { registeredBlobsGuard } from './object-release.js';

type Row = Record<string, unknown>;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An imported archived event, its reference and publication evidence share one atomic write. */
export async function restoreArchivedEvent(
  db: RelationalStore, event: Row, ref: Row, proofs: readonly Row[], rawRef?: Row,
): Promise<number> {
  const project = event.project_id;
  const id = event.event_id;
  if (typeof project !== 'string' || typeof id !== 'string' || event.payload_format !== 'archived'
    || event.payload !== '{}' || ref.project_id !== project || ref.event_id !== id
    || ref.session_id !== event.session_id || ref.source_envelope_hash !== event.envelope_hash
    || ref.version !== 1 || ref.digest !== ref.archive_key || !Number.isSafeInteger(ref.size)) {
    throw new Error('an archived event and its content reference disagree');
  }
  const body = ref.archive_key;
  const receipt = ref.receipt_key;
  if (typeof body !== 'string' || typeof receipt !== 'string') throw new Error('an archived event lacks body or receipt');
  for (const key of [body, receipt]) {
    if (!proofs.some(proof => proof.project_id === project && proof.key === key && proof.event_id === id
      && proof.session_id === event.session_id && proof.envelope_hash === event.envelope_hash
      && (key === body ? proof.source_kind === 'event' && proof.source_id === id
        : proof.source_kind === 'receipt' && proof.source_id === `event:${id}`)
      && proof.digest === key && proof.durable === 1 && (key !== body || proof.size === ref.size))) {
      throw new Error('an archived event lacks its verified body or receipt proof');
    }
  }
  if (rawRef !== undefined && (rawRef.project_id !== project || rawRef.source_kind !== 'event'
    || rawRef.source_id !== id || rawRef.session_id !== event.session_id)) {
    throw new Error('an archived event and its raw archive reference disagree');
  }

  const columnsOf = (row: Row): string[] => {
    const columns = Object.keys(row);
    if (!columns.every(column => IDENTIFIER.test(column))) throw new Error('an archived content row carries an invalid column name');
    return columns;
  };
  const insert = (table: string, row: Row, where?: string, whereValues: unknown[] = []): PreparedStatement => {
    const columns = columnsOf(row);
    return db.prepare(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) SELECT ${columns.map(() => '?').join(', ')}${where === undefined ? '' : ` WHERE ${where}`} RETURNING rowid`)
      .bind(...columns.map(column => row[column] ?? null), ...whereValues);
  };
  const matches = (table: string, row: Row, alias: string): { sql: string; values: unknown[] } => {
    const columns = columnsOf(row);
    return { sql: `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${columns.map(column => `${alias}.${column} IS ?`).join(' AND ')})`,
      values: columns.map(column => row[column] ?? null) };
  };
  const eventMatch = matches('events', event, 'e');
  const refMatch = matches('event_content_refs', ref, 'r');
  const statements: PreparedStatement[] = [];
  if (rawRef !== undefined) {
    const rawMatch = matches('raw_archive_refs', rawRef, 'r');
    statements.push(db.prepare(`INSERT INTO restore_reference_guard (missing)
      SELECT 'raw archive reference conflicts with a new event'
      WHERE NOT EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ?)
        AND EXISTS (SELECT 1 FROM raw_archive_refs WHERE project_id = ? AND source_kind = 'event' AND source_id = ?)
        AND NOT ${rawMatch.sql}`)
      .bind(project, id, project, id, ...rawMatch.values));
  }
  const insertedIndex = statements.length + 1;
  statements.push(
    registeredBlobsGuard(db, [{ projectId: project, key: body }, { projectId: project, key: receipt }]),
    insert('events', event),
    insert('event_content_refs', ref, eventMatch.sql, eventMatch.values),
  );

  for (const proof of proofs) {
    const columns = columnsOf(proof);
    const values = columns.filter(column => column !== 'generation');
    statements.push(db.prepare(`INSERT OR IGNORE INTO registered_content_proofs (${columns.join(', ')})
      SELECT ${columns.map(column => column === 'generation' ? 'b.generation' : '?').join(', ')}
      FROM blobs b WHERE b.project_id = ? AND b.key = ? AND b.size = ?
        AND ${eventMatch.sql}`)
      .bind(...values.map(column => proof[column] ?? null), project, proof.key, proof.size, ...eventMatch.values));
  }
  if (rawRef !== undefined) statements.push(insert('raw_archive_refs', rawRef, eventMatch.sql, eventMatch.values));

  const proofChecks = proofs.map(proof => {
    const expected = { ...proof };
    delete expected.generation;
    const columns = columnsOf(expected);
    return { sql: `EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id = p.project_id AND b.key = p.key AND b.generation IS p.generation
      WHERE ${columns.map(column => `p.${column} IS ?`).join(' AND ')})`,
      values: columns.map(column => expected[column] ?? null) };
  });
  statements.push(db.prepare(`INSERT INTO restore_reference_guard (missing)
    SELECT 'archived event closure' WHERE ${eventMatch.sql}
      AND NOT (${[refMatch.sql, ...proofChecks.map(check => check.sql)].join(' AND ')})`)
    .bind(...eventMatch.values, ...refMatch.values, ...proofChecks.flatMap(check => check.values)));
  const results = await db.batch(statements);
  return results[insertedIndex]!.results.length;
}
