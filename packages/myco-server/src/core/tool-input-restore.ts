import type { PreparedStatement, RelationalStore } from './adapters.js';
import { registeredBlobsGuard } from './object-release.js';

type Row = Record<string, unknown>;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A displayed input, its full body proof and processed reference restore in one transaction. */
export async function restoreToolInput(
  db: RelationalStore, tool: Row, outcomeEvent: Row, inputEvent: Row, processed: Row, proofs: readonly Row[],
): Promise<number> {
  const project = tool.project_id;
  const id = tool.tool_call_id;
  const key = tool.input_blob_key;
  const bytes = tool.input_bytes;
  if (typeof project !== 'string' || typeof id !== 'string' || typeof key !== 'string'
    || !Number.isSafeInteger(bytes) || (bytes as number) <= 2048
    || typeof tool.input !== 'string' || new TextEncoder().encode(tool.input).byteLength > 2048
    || outcomeEvent.project_id !== project || outcomeEvent.event_id !== tool.event_id || outcomeEvent.session_id !== tool.session_id
    || inputEvent.project_id !== project || inputEvent.event_id !== processed.event_id || inputEvent.session_id !== tool.session_id
    || processed.project_id !== project || processed.kind !== 'tool-input'
    || processed.resource_id !== id || processed.blob_key !== key
    || processed.source_token_id !== inputEvent.token_id
    || processed.classification !== 'processed') {
    throw new Error('a displayed tool input lacks its exact source and processed reference');
  }
  const body = proofs.find(proof => proof.project_id === project && proof.key === key
    && proof.source_kind === 'tool-input' && proof.source_id === id
    && proof.event_id === inputEvent.event_id && proof.envelope_hash === inputEvent.envelope_hash
    && proof.session_id === tool.session_id && proof.digest === key && proof.size === bytes && proof.durable === 1);
  if (body === undefined) throw new Error('a displayed tool input lacks its full body proof');
  if (!proofs.every(proof => proof.project_id === project && proof.event_id === inputEvent.event_id
    && proof.envelope_hash === inputEvent.envelope_hash && proof.session_id === tool.session_id
    && proof.digest === proof.key && proof.durable === 1)) {
    throw new Error('a displayed tool input has a proof for another source');
  }
  const columnsOf = (row: Row): string[] => {
    const columns = Object.keys(row);
    if (!columns.every(column => IDENTIFIER.test(column))) throw new Error('a tool input restore row carries an invalid column name');
    return columns;
  };
  const matches = (table: string, row: Row, alias: string): { sql: string; values: unknown[] } => {
    const columns = columnsOf(row);
    return { sql: `EXISTS (SELECT 1 FROM ${table} ${alias} WHERE ${columns.map(column => `${alias}.${column} IS ?`).join(' AND ')})`,
      values: columns.map(column => row[column] ?? null) };
  };
  const outcome = { project_id: project, event_id: tool.event_id, envelope_hash: outcomeEvent.envelope_hash, ingest_nonce: outcomeEvent.ingest_nonce };
  const inputSource = { project_id: project, event_id: processed.event_id, envelope_hash: inputEvent.envelope_hash,
    ingest_nonce: inputEvent.ingest_nonce, session_id: tool.session_id, token_id: processed.source_token_id };
  const outcomeMatch = matches('events', outcome, 'e');
  const inputMatch = matches('events', inputSource, 'ie');
  const toolMatch = matches('tool_calls', tool, 't');
  const processedMatch = matches('processed_resources', processed, 'p');
  const toolColumns = columnsOf(tool);
  const processedColumns = columnsOf(processed);
  const statements: PreparedStatement[] = [
    registeredBlobsGuard(db, proofs.map(proof => ({ projectId: project, key: proof.key as string }))),
    db.prepare(`INSERT OR IGNORE INTO processed_resources (${processedColumns.join(', ')})
      SELECT ${processedColumns.map(() => '?').join(', ')} WHERE ${outcomeMatch.sql} AND ${inputMatch.sql}
        AND (NOT EXISTS (SELECT 1 FROM tool_calls WHERE project_id = ? AND tool_call_id = ?) OR ${toolMatch.sql})`)
      .bind(...processedColumns.map(column => processed[column] ?? null), ...outcomeMatch.values, ...inputMatch.values,
        project, id, ...toolMatch.values),
    db.prepare(`INSERT OR IGNORE INTO tool_calls (${toolColumns.join(', ')})
      SELECT ${toolColumns.map(() => '?').join(', ')} WHERE ${outcomeMatch.sql} AND ${inputMatch.sql} RETURNING rowid`)
      .bind(...toolColumns.map(column => tool[column] ?? null), ...outcomeMatch.values, ...inputMatch.values),
  ];
  for (const proof of proofs) {
    const columns = columnsOf(proof);
    statements.push(db.prepare(`INSERT OR IGNORE INTO registered_content_proofs (${columns.join(', ')})
      SELECT ${columns.map(column => column === 'generation' ? 'b.generation' : '?').join(', ')}
      FROM blobs b WHERE b.project_id = ? AND b.key = ? AND b.size = ?
        AND ${outcomeMatch.sql} AND ${inputMatch.sql} AND ${toolMatch.sql}`)
      .bind(...columns.filter(column => column !== 'generation').map(column => proof[column] ?? null),
        project, proof.key, proof.size, ...outcomeMatch.values, ...inputMatch.values, ...toolMatch.values));
  }
  const proofChecks = proofs.map(proof => {
    const expected = { ...proof };
    delete expected.generation;
    const columns = columnsOf(expected);
    return { sql: `EXISTS (SELECT 1 FROM registered_content_proofs p JOIN blobs b
      ON b.project_id = p.project_id AND b.key = p.key AND b.generation IS p.generation
      WHERE ${columns.map(column => `p.${column} IS ?`).join(' AND ')} AND b.size = p.size)`,
      values: columns.map(column => expected[column] ?? null) };
  });
  statements.push(db.prepare(`INSERT INTO restore_reference_guard (missing)
    SELECT 'tool input closure' WHERE ${outcomeMatch.sql} AND ${inputMatch.sql} AND ${toolMatch.sql}
      AND NOT (${[processedMatch.sql, ...proofChecks.map(check => check.sql)].join(' AND ')})`)
    .bind(...outcomeMatch.values, ...inputMatch.values, ...toolMatch.values,
      ...processedMatch.values, ...proofChecks.flatMap(check => check.values)));
  const results = await db.batch(statements);
  return results[2]!.results.length;
}
