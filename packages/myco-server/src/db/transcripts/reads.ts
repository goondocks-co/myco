import { transcriptRoleSql } from '../transcript-order.js';
import { read } from '../index.js';

export interface HeldTranscriptRow { transcript_id: string; session_id: string; size: number; head_hash: string | null; role: string }

/** The transcripts held under these identities. */
export const heldByIdentity = read<[project: string, ids: string], HeldTranscriptRow>({ name: 'transcripts.heldByIdentity', sql:
  'SELECT t.transcript_id,t.session_id,t.size,t.head_hash,t.role FROM json_each(?2) i CROSS JOIN transcripts t ON t.project_id=?1 AND t.transcript_id=i.value' });

/** One page of the transcripts these sessions hold, in `(session, transcript)` order. */
export const heldBySessionPage = read<[project: string, sessions: string, afterSession: string, afterTranscript: string, limit: number], HeldTranscriptRow>({ name: 'transcripts.heldBySessionPage', sql:
  `SELECT t.transcript_id,t.session_id,t.size,t.head_hash,t.role FROM json_each(?2) s CROSS JOIN transcripts t ON t.project_id=?1 AND t.session_id=s.value
    WHERE (t.session_id,t.transcript_id)>(?3,?4) ORDER BY t.session_id,t.transcript_id LIMIT ?5` });

/** Which of these sessions hold at least one transcript, optionally only on one machine and only with bytes. */
export const sessionsHoldingTranscript = read<[project: string, sessions: string, machine: string | null, minSize: number], { session_id: string }>({ name: 'transcripts.sessionsHolding', sql:
  `SELECT s.value AS session_id FROM json_each(?2) s
    WHERE EXISTS(SELECT 1 FROM transcripts t WHERE t.project_id=?1 AND t.session_id=s.value AND t.size>=?4 AND (?3 IS NULL OR t.machine_id=?3))` });

const TRANSCRIPT_COLUMNS = `t.transcript_id,t.session_id,t.machine_id,t.agent,t.origin_path,t.size,t.segment_count,
  t.first_received_at,t.last_received_at,t.role,COALESCE(p.published_offset,0) AS parsed_offset,p.updated_at AS parsed_at,t.fidelity,
  CASE WHEN p.state='awaiting' THEN 'awaiting_bytes' WHEN p.state='failed' THEN p.failure END AS parse_error,
  CASE WHEN p.state='failed' THEN p.updated_at END AS parse_failed_at`;

export interface TranscriptPageRow {
  transcript_id: string; session_id: string; machine_id: string; agent: string | null; origin_path: string | null; size: number; segment_count: number;
  first_received_at: number; last_received_at: number; role: string | null; parsed_offset: number | null; parsed_at: number | null;
  fidelity: string | null; parse_error: string | null; parse_failed_at: number | null;
}

/** One role's page of a session's transcripts, seeking from the id `after` (`''` from the start); `only` narrows to one transcript. */
export const transcriptsOfRole = read<[project: string, session: string, role: number, after: string, only: string | null, limit: number], TranscriptPageRow>({ name: 'transcripts.ofRole', sql:
  `SELECT ${TRANSCRIPT_COLUMNS} FROM (SELECT project_id,transcript_id FROM transcripts INDEXED BY idx_transcripts_session_page
      WHERE project_id=?1 AND session_id=?2 AND ${transcriptRoleSql()}=?3 AND transcript_id>?4 AND (?5 IS NULL OR transcript_id=?5)
      ORDER BY transcript_id LIMIT ?6) k
    CROSS JOIN transcripts t ON t.project_id=k.project_id AND t.transcript_id=k.transcript_id
    LEFT JOIN session_documents d ON d.project_id=t.project_id AND d.session_id=t.session_id AND d.state='live'
    LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=d.generation
    ORDER BY t.transcript_id` });

export interface SegmentPageRow { base_offset: number; length: number; blob_key: string; created_at: number }
const segmentSeek = (idExpr: string) => `AND base_offset>=?3 AND (base_offset>?3 OR ${idExpr}>?4)`;

/** Hot ranges past the cursor, whose id compares `'hot:'||blob_key` for ties on the offset. */
export const hotSegmentsPage = read<[project: string, transcript: string, afterOffset: number, afterId: string, limit: number], SegmentPageRow>({ name: 'transcripts.hotSegmentsPage', sql:
  `SELECT base_offset,length,blob_key,created_at FROM transcript_segments WHERE project_id=?1 AND transcript_id=?2 ${segmentSeek("'hot:'||blob_key")}
    ORDER BY base_offset,blob_key LIMIT ?5` });
export const archivedSegmentsPage = read<[project: string, transcript: string, afterOffset: number, afterId: string, limit: number], SegmentPageRow>({ name: 'transcripts.archivedSegmentsPage', sql:
  `SELECT base_offset,length,archive_key AS blob_key,created_at FROM raw_archive_refs INDEXED BY idx_raw_archive_transcript_page
    WHERE project_id=?1 AND transcript_id=?2 AND source_kind='transcript' AND disposition='archived' ${segmentSeek("'archived:'||archive_key")}
    ORDER BY base_offset,archive_key LIMIT ?5` });
