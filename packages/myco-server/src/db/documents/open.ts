import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { publicationPolicy } from '../../ingest/publication-policy.js';
import { dependencyTranslationPending } from './dependencies.js';

export interface DocumentRow {
  publication_input_revision: number; publication_after: string | null; publication_scan_due: number | null; publication_wake: string | null;
  generation: number; next_chunk: number; first_prompt: string | null; open_turn_key: string | null;
  prompts: number; token_id: string; ended_at: number | null; working_since: number | null; last_turn_end_at: number | null;
}
export interface TranscriptRow {
  priority: number; first_received_at: number; transcript_id: string; agent: string | null; role: string | null; size: number; machine_id: string; token_id: string;
  prompt_identity_scheme: string | null; imported_at: number | null; last_received_at: number;
  publication_parser_version: number | null; diagnostic: string | null; published_offset: number | null; segment_lines: number | null; open_prompt_id: string | null; unfinished: number | null;
  reply_unfinished: number | null; reply_latest_at: number | null; prompt_scheme: string | null; record_scheme: string | null;
  state: string | null; failure: string | null; awaited_size: number | null; updated_at: number | null;
  placed_records: number | null; placed_digest: string | null;
}
export interface QueuedRow {
  event_id: string; rank: number; retry_at: number; retry_cause: string | null; queued_created_at: number; kind: string; payload: string; payload_format: string; created_at: number;
  received_at: number;
}


export const PUBLICATION_TRANSCRIPTS_PAGE = 16;
export const PUBLICATION_QUEUE_PAGE = 200;
export const TRANSCRIPT_PRIORITY = "CASE t.role WHEN 'subagent' THEN 1 ELSE 0 END";
const policy = publicationPolicy('t.prompt_identity_scheme');
const control = read<[string, string], DocumentRow>({ name: 'publication.control', sql: `SELECT d.generation,d.next_chunk,d.first_prompt,d.open_turn_key,d.prompts,s.created_by_token_id token_id,
  d.publication_input_revision,d.publication_after,d.publication_scan_due,d.publication_wake,s.ended_at,s.working_since,s.last_turn_end_at
  FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
  WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)` });
const transcripts = read<[string, string, number, number, number, string], TranscriptRow>({ name: 'publication.transcriptPage', sql: `SELECT t.transcript_id,t.agent,t.role,t.size,t.machine_id,t.token_id,t.prompt_identity_scheme,t.imported_at,t.last_received_at,
  ${TRANSCRIPT_PRIORITY} priority,t.first_received_at,
  p.parser_version AS publication_parser_version,p.diagnostic,p.published_offset,p.segment_lines,p.open_prompt_id,p.unfinished,p.reply_unfinished,p.reply_latest_at,
  CASE WHEN p.published_offset IS NULL THEN ${policy.prompt} ELSE p.prompt_scheme END prompt_scheme,
  CASE WHEN p.published_offset IS NULL THEN ${policy.record} ELSE p.record_scheme END record_scheme,
  p.state,p.failure,p.awaited_size,p.updated_at,p.placed_records,p.placed_digest
  FROM transcripts t INDEXED BY idx_publication_transcripts LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=?3
  WHERE t.project_id=?1 AND t.session_id=?2
    AND ${TRANSCRIPT_PRIORITY}=?4 AND (t.first_received_at,t.transcript_id)>(?5,?6)
  ORDER BY t.first_received_at,t.transcript_id LIMIT ${PUBLICATION_TRANSCRIPTS_PAGE}` });
const queued = read<[string, string, number], QueuedRow>({ name: 'publication.queuedPage', sql: `SELECT q.event_id,q.rank,q.retry_at,q.retry_cause,q.created_at queued_created_at,e.kind,e.payload,e.payload_format,e.created_at,e.received_at
  FROM (SELECT * FROM (SELECT rank,created_at,event_id,retry_at,retry_cause FROM publish_queue
      WHERE project_id=?1 AND session_id=?2 AND failure IS NULL AND retry_cause IS NULL ORDER BY rank,created_at,event_id LIMIT ${PUBLICATION_QUEUE_PAGE})
    UNION ALL SELECT * FROM (SELECT rank,created_at,event_id,retry_at,retry_cause FROM publish_queue
      WHERE project_id=?1 AND session_id=?2 AND failure IS NULL AND retry_cause IS NOT NULL AND retry_at<=?3 ORDER BY retry_at,rank,created_at,event_id LIMIT ${PUBLICATION_QUEUE_PAGE})) q
  JOIN events e ON e.project_id=?1 AND e.event_id=q.event_id ORDER BY q.rank,q.created_at,q.event_id LIMIT ${PUBLICATION_QUEUE_PAGE}` });

export async function openPublication(db: RelationalStore, project: string, session: string, now: number) {
  const [docs, events, translation] = await readSet(db, control.bind(project, session), queued.bind(project, session, now), dependencyTranslationPending(project, session));
  return { docs, queued: events, translationPending: translation.length > 0 };
}

export async function publicationTranscripts(db: RelationalStore, project: string, session: string, generation: number, after: string | null) {
  const cursor: unknown = after === null ? [0, Number.MIN_SAFE_INTEGER, ''] : JSON.parse(after);
  if (!Array.isArray(cursor) || ![0, 1].includes(cursor[0]) || !Number.isSafeInteger(cursor[1]) || typeof cursor[2] !== 'string') {
    throw new Error('document_directory_cursor_invalid');
  }
  const arms = [0, 1].filter(priority => priority >= cursor[0]).map(priority => transcripts.bind(project, session, generation,
    priority, priority === cursor[0] ? cursor[1] : Number.MIN_SAFE_INTEGER, priority === cursor[0] ? cursor[2] : ''));
  return (await readSet(db, ...arms)).flat().slice(0, PUBLICATION_TRANSCRIPTS_PAGE);
}
