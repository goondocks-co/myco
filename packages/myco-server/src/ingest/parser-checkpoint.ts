import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { MAX_PAYLOAD_BYTES } from './envelope.js';
import { sha256HexOf, utf8 } from '../hash.js';
import type { ParserState } from './parsers/index.js';

/** Four UTF-8 bytes per code unit keep every chunk under the row's encoded-byte bound. */
export const PARSER_CHECKPOINT_CHARS = Math.floor(MAX_PAYLOAD_BYTES / 4);

interface CheckpointTarget { projectId: string; transcriptId: string; parsedOffset: number }

export async function readParserCheckpoint(db: RelationalStore, target: CheckpointTarget, digest: unknown): Promise<ParserState> {
  const { results } = await db.prepare(`SELECT chunk_index, chunk_count, payload FROM transcript_parser_state_chunks
    WHERE project_id = ? AND transcript_id = ? AND cursor_offset = ? ORDER BY chunk_index`)
    .bind(target.projectId, target.transcriptId, target.parsedOffset).all<{ chunk_index: number; chunk_count: number; payload: string }>();
  if (results.length === 0 || results.some((row, index) => row.chunk_index !== index || row.chunk_count !== results.length))
    throw new Error('Stored parser checkpoint is incomplete');
  const encoded = results.map((row) => row.payload).join('');
  if (typeof digest !== 'string' || await sha256HexOf(utf8(encoded)) !== digest) throw new Error('Stored parser checkpoint digest differs');
  return JSON.parse(encoded) as ParserState;
}

/** State rows and the cursor statement belong to one atomic batch. */
export async function parserCheckpointStatements(
  db: RelationalStore, target: CheckpointTarget, to: number, state: ParserState, metadata: Record<string, unknown> | undefined,
  priorChunked: boolean, advance: (context: string) => PreparedStatement,
): Promise<PreparedStatement[]> {
  const encoded = JSON.stringify(state);
  const chunked = utf8(encoded).length > MAX_PAYLOAD_BYTES;
  const context = JSON.stringify({ ...metadata, mycoParserMeta: metadata ?? null,
    mycoParserRepair: state.repair,
    mycoParserReplyUnfinished: state.reply !== undefined ? 1 : 0,
    mycoParserReplyLatestAt: state.reply === undefined ? null : state.reply.parts.reduce((latest, part) => Math.max(latest, part.createdAt), 0),
    mycoParserUnfinished: Object.keys(state.pending ?? {}).length > 0 || state.reply !== undefined ? 1 : 0,
    mycoParserState: chunked ? { chunked: true, digest: await sha256HexOf(utf8(encoded)) } : state });
  const guard = 'EXISTS (SELECT 1 FROM transcripts WHERE project_id = ? AND transcript_id = ? AND parsed_offset = ? AND parser_context = ?)';
  const guarded = [target.projectId, target.transcriptId, to, context];
  const statements: PreparedStatement[] = [advance(context)];
  if (priorChunked || chunked) statements.push(db.prepare(`DELETE FROM transcript_parser_state_chunks WHERE project_id = ? AND transcript_id = ? AND ${guard}`)
    .bind(target.projectId, target.transcriptId, ...guarded));
  if (chunked) {
    const chunks: string[] = [];
    for (let offset = 0; offset < encoded.length;) {
      let end = Math.min(offset + PARSER_CHECKPOINT_CHARS, encoded.length);
      if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1])) end -= 1;
      chunks.push(encoded.slice(offset, end));
      offset = end;
    }
    for (const [index, payload] of chunks.entries()) {
      statements.push(db.prepare(`INSERT INTO transcript_parser_state_chunks (project_id, transcript_id, cursor_offset, chunk_index, chunk_count, payload)
        SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`)
        .bind(target.projectId, target.transcriptId, to, index, chunks.length, payload, ...guarded));
    }
  }
  return statements;
}

/** Additive restore can reuse a checkpoint only under the exact cursor and state its artifact captured. */
export function restoreParserCheckpointStatement(db: RelationalStore, row: Record<string, unknown>, parent: Record<string, unknown>): PreparedStatement {
  if (row.project_id !== parent.project_id || row.transcript_id !== parent.transcript_id || row.cursor_offset !== parent.parsed_offset) {
    throw new Error('Parser checkpoint does not belong to its artifact cursor');
  }
  const columns = Object.keys(row);
  return db.prepare(`INSERT OR IGNORE INTO transcript_parser_state_chunks (${columns.join(', ')})
    SELECT ${columns.map(() => '?').join(', ')} WHERE EXISTS (SELECT 1 FROM transcripts
      WHERE project_id = ? AND transcript_id = ? AND parsed_offset = ? AND parser_context IS ?) RETURNING rowid`)
    .bind(...columns.map((column) => row[column] ?? null), parent.project_id, parent.transcript_id, parent.parsed_offset, parent.parser_context);
}

interface TerminalFence extends CheckpointTarget {
  size: number; lastReceivedAt?: number; parserContextJson?: string | null; parserContext?: Record<string, unknown> | null;
}
/** Integer overflow aborts the whole transaction before a stale terminal batch writes any row. */
export async function terminalCheckpointBatch(db: RelationalStore, target: TerminalFence, statements: PreparedStatement[]) {
  const stable = `EXISTS (SELECT 1 FROM transcripts WHERE project_id = ? AND transcript_id = ?
    AND parsed_offset = ? AND size = ? AND last_received_at = ? AND parser_context IS ?)`;
  const values = [target.projectId, target.transcriptId, target.parsedOffset, target.size, target.lastReceivedAt,
    target.parserContextJson ?? (target.parserContext == null ? null : JSON.stringify(target.parserContext))];
  try {
    const result = await db.batch([db.prepare(`SELECT CASE WHEN ${stable} THEN 1 ELSE abs(-9223372036854775808) END AS terminal_checkpoint_stable`).bind(...values), ...statements]);
    return result.slice(1);
  } catch (error) {
    if (!String(error).includes('integer overflow')) throw error;
    const current = await db.prepare(`SELECT ${stable} AS stable`).bind(...values).first<{ stable: number }>();
    if (current?.stable !== 0) throw error;
    return null;
  }
}
