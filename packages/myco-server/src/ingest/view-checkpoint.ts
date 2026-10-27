import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { PARSER_CHECKPOINT_CHARS, mirrorViewParserCheckpointStatements } from './parser-checkpoint.js';
import { MAX_PAYLOAD_BYTES } from './envelope.js';
import type { ParserState } from './parsers/index.js';
import type { ViewWriteTarget } from './view-guard.js';
import { PARSER_VERSION } from './parse.js';

export interface ViewCheckpoint {
  transcriptId: string;
  offset: number;
  context: string | null;
  openPromptId: string | null;
  segmentLines?: number;
}
const CHECKPOINT_CHUNKS_PER_STATEMENT = 8;

export async function viewCheckpointStatements(
  db: RelationalStore,
  target: ViewWriteTarget,
  checkpoint: ViewCheckpoint,
  to: number,
  state: ParserState,
  metadata: Record<string, unknown> | undefined,
  now: number,
  through: number | null,
  fidelity: string,
): Promise<PreparedStatement[]> {
  const encoded = JSON.stringify(state),
    chunks: string[] = [];
  if (new TextEncoder().encode(encoded).length > MAX_PAYLOAD_BYTES)
    for (let at = 0; at < encoded.length; ) {
      let end = Math.min(at + PARSER_CHECKPOINT_CHARS, encoded.length);
      if (end < encoded.length && /[\uD800-\uDBFF]/.test(encoded[end - 1]!)) end--;
      chunks.push(encoded.slice(at, end));
      at = end;
    }
  const context = JSON.stringify({
    ...metadata,
    mycoParserViewCheckpoint: 1,
    mycoParserMeta: metadata ?? null,
    mycoParserReadSize: to,
    mycoParserUnfinished: Object.keys(state.pending ?? {}).length > 0 || state.reply !== undefined ? 1 : 0,
    mycoParserReplyUnfinished: state.reply === undefined ? 0 : 1,
    mycoParserReplyLatestAt: state.reply?.parts.reduce((latest, part) => Math.max(latest, part.createdAt), 0) ?? null,
    mycoParserState: chunks.length ? { chunked: true, digest: await sha256Hex(encoded) } : state,
  });
  const pages = chunks.map((payload, index) => ({ payload, index }));
  const scope = [target.projectId, target.instanceId, checkpoint.transcriptId];
  return [
    db
      .prepare(
        `UPDATE view_checkpoints SET parsed_offset=?,parser_context=?,open_prompt_id=?,parsed_at=?,parser_version=?,
      parsed_through_at=COALESCE(?,parsed_through_at),parse_segment_lines=?,fidelity=?,parse_error=NULL,parse_failed_at=NULL,parse_awaited_size=NULL
      WHERE project_id=? AND instance_id=? AND transcript_id=?`,
      )
      .bind(
        to,
        context,
        checkpoint.openPromptId,
        now,
        PARSER_VERSION,
        through,
        checkpoint.segmentLines ?? 0,
        fidelity,
        ...scope,
      ),
    db
      .prepare(`DELETE FROM view_checkpoint_chunks WHERE project_id=? AND instance_id=? AND transcript_id=?`)
      .bind(...scope),
    ...Array.from({ length: Math.ceil(pages.length / CHECKPOINT_CHUNKS_PER_STATEMENT) }, (_, page) =>
      db
        .prepare(
          `INSERT INTO view_checkpoint_chunks(project_id,instance_id,session_id,transcript_id,cursor_offset,chunk_index,chunk_count,payload)
      SELECT ?,?,?,?,?,json_extract(value,'$.index'),?,json_extract(value,'$.payload') FROM json_each(?)`,
        )
        .bind(
          target.projectId,
          target.instanceId,
          target.sessionId,
          checkpoint.transcriptId,
          to,
          chunks.length,
          JSON.stringify(
            pages.slice(page * CHECKPOINT_CHUNKS_PER_STATEMENT, (page + 1) * CHECKPOINT_CHUNKS_PER_STATEMENT),
          ),
        ),
    ),
  ];
}

/** Only the live instance supplies the frontier and continuation used by maintenance. */
export function liveFrontierMirrorStatements(
  db: RelationalStore,
  target: ViewWriteTarget,
  transcriptId?: string,
): PreparedStatement[] {
  if (target.mirrorFrontier === false) return [];
  return [
    db
      .prepare(
        `UPDATE transcripts SET
    (parsed_offset,parser_context,open_prompt_id,parsed_at,parser_version,parsed_through_at,fidelity,parse_error,parse_failed_at,parse_awaited_size,parse_segment_lines,prompt_generation)=
    (SELECT c.parsed_offset,c.parser_context,c.open_prompt_id,c.parsed_at,c.parser_version,c.parsed_through_at,c.fidelity,c.parse_error,c.parse_failed_at,c.parse_awaited_size,c.parse_segment_lines,c.prompt_generation
      FROM view_checkpoints c WHERE c.project_id=transcripts.project_id AND c.instance_id=? AND c.transcript_id=transcripts.transcript_id)
    WHERE project_id=? AND session_id=? AND EXISTS(SELECT 1 FROM session_views s WHERE s.project_id=transcripts.project_id AND s.session_id=transcripts.session_id AND s.live_instance=?)
    AND EXISTS(SELECT 1 FROM view_checkpoints c WHERE c.project_id=transcripts.project_id AND c.instance_id=? AND c.transcript_id=transcripts.transcript_id)${transcriptId === undefined ? '' : ' AND transcript_id=?'}`,
      )
      .bind(
        target.instanceId,
        target.projectId,
        target.sessionId,
        target.instanceId,
        target.instanceId,
        ...(transcriptId === undefined ? [] : [transcriptId]),
      ),
    ...mirrorViewParserCheckpointStatements(db, target, transcriptId),
  ];
}
