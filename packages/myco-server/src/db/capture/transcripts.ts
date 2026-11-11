/**
 * A captured `transcript.segment` event's projections: the segment, its transcript's size and receipt, and the session's
 * agent, each written only when this request stored the event and the segment row it adds. A transcript registers once
 * with the prompt and record schemes its group admits, and keeps them.
 */
import { LEGACY_RECORD_ID_SCHEME } from '@goondocks/myco-shared/record-identity';
import { archivedTranscriptRangeSql } from '../documents/ranges.js';
import { admittedSchemeSql } from '../documents/pins.js';
import { recordDeclarations, recordSchemeSql } from '../documents/record-pins.js';
import { read, write, type BindValue, type Bound } from '../index.js';
import { storedByThisRequest } from './event-write.js';
import type { Stored } from './sessions.js';
import { Slots } from './slots.js';

type Label = 'project' | 'transcript' | 'session' | 'machine' | 'agent' | 'originPath' | 'role' | 'headHash' | 'size' | 'now' | 'token'
  | 'importedAt' | 'legacy' | 'event' | 'nonce' | 'baseOffset';

const segment = write<[project: string, transcript: string, offset: number, length: number, blob: string, event: string, createdAt: number,
  receivedAt: number, token: string, nonce: string], { applied: number }>({ name: 'capture.transcriptSegment', sql:
  `INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${storedByThisRequest('?1', '?6', '?10')} AND NOT ${archivedTranscriptRangeSql('?1', '?2', '?3')}
    ON CONFLICT (project_id, transcript_id, base_offset) DO NOTHING RETURNING 1 AS applied` });

/** The segment row this request added. */
const segmentWritten = (s: Slots<Label>) =>
  `EXISTS (SELECT 1 FROM transcript_segments WHERE project_id = ${s.at('project')} AND transcript_id = ${s.at('transcript')} AND base_offset = ${s.at('baseOffset')} AND event_id = ${s.at('event')})`;

/**
 * The transcript row. `imported_at` is the lane of the newest segment, not the first: a session imported and then
 * continued live is live work. The record scheme's declarations are rendered once and validated again for every
 * segment, so an invalid declaration refuses every registering transcript with `record_identity_scheme_unsupported`.
 */
const registration = ((): { slots: Slots<Label>; statement: ReturnType<typeof write<BindValue[], { applied: number }>> } | { refused: unknown } => {
  const s = new Slots<Label>();
  let record: string;
  try { record = recordSchemeSql(s.at('agent'), s.at('legacy')); }
  catch (error) { return { refused: error }; }
  const statement = write<BindValue[], { applied: number }>({ name: 'capture.transcriptRegistration', sql:
    `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, origin_path, role, head_hash, size, segment_count, first_received_at,
        last_received_at, token_id, imported_at, prompt_identity_scheme, record_identity_scheme)
      SELECT ${s.at('project')}, ${s.at('transcript')}, ${s.at('session')}, ${s.at('machine')}, ${s.at('agent')}, ${s.at('originPath')}, ${s.at('role')},
        ${s.at('headHash')}, ${s.at('size')}, 1, ${s.at('now')}, ${s.at('now')}, ${s.at('token')}, ${s.at('importedAt')},
        ${admittedSchemeSql(s.at('project'), s.at('session'), s.at('agent'))}, ${record}
        WHERE ${storedByThisRequest(s.at('project'), s.at('event'), s.at('nonce'))} AND ${segmentWritten(s)}
      ON CONFLICT (project_id, transcript_id) DO UPDATE SET size = excluded.size, segment_count = transcripts.segment_count + 1,
        last_received_at = excluded.last_received_at, head_hash = COALESCE(transcripts.head_hash, excluded.head_hash),
        imported_at = excluded.imported_at RETURNING 1 AS applied` });
  return { slots: s, statement };
})();

const agentSlots = new Slots<Label>();
const sessionAgent = write<BindValue[], { applied: number }>({ name: 'capture.transcriptSessionAgent', sql:
  `UPDATE sessions SET agent = COALESCE(agent, ${agentSlots.at('agent')}) WHERE project_id = ${agentSlots.at('project')} AND session_id = ${agentSlots.at('session')}
    AND ${storedByThisRequest(agentSlots.at('project'), agentSlots.at('event'), agentSlots.at('nonce'))} AND ${segmentWritten(agentSlots)} RETURNING 1 AS applied` });

const transcriptRow = read<[project: string, transcript: string], { size: number; segment_count: number; machine_id: string; head_hash: string | null }>({
  name: 'capture.transcriptHeld', sql: 'SELECT size, segment_count, machine_id, head_hash FROM transcripts WHERE project_id = ?1 AND transcript_id = ?2' });
const segmentRow = read<[project: string, transcript: string, offset: number], { blob_key: string; length: number }>({ name: 'capture.segmentHeld', sql:
  'SELECT blob_key, length FROM transcript_segments WHERE project_id = ?1 AND transcript_id = ?2 AND base_offset = ?3' });
const blobSize = read<[project: string, blob: string], { size: number }>({ name: 'capture.segmentBlobSize', sql:
  'SELECT size FROM blobs WHERE project_id = ?1 AND key = ?2' });

/** One segment event's values. */
export interface SegmentEvent {
  transcriptId: string; baseOffset: number; length: number; blob: string; headHash: string | null; agent: string | null; originPath: string | null;
  role: string; machine: string; token: string; createdAt: number; now: number; imported: boolean;
}

/** The segment, the transcript and the session's agent, in that order. */
export function segmentProjections(st: Stored, g: SegmentEvent): Bound<{ applied: number }>[] {
  recordDeclarations();
  if ('refused' in registration) throw registration.refused;
  const values: Record<Label, BindValue> = {
    project: st.project, transcript: g.transcriptId, session: st.session, machine: g.machine, agent: g.agent, originPath: g.originPath, role: g.role,
    headHash: g.headHash, size: g.baseOffset + g.length, now: g.now, token: g.token, importedAt: g.imported ? g.now : null, legacy: LEGACY_RECORD_ID_SCHEME,
    event: st.event, nonce: st.nonce, baseOffset: g.baseOffset,
  };
  return [
    segment.bind(st.project, g.transcriptId, g.baseOffset, g.length, g.blob, st.event, g.createdAt, g.now, g.token, st.nonce),
    registration.statement.bind(...registration.slots.values(values)),
    sessionAgent.bind(...agentSlots.values(values)),
  ];
}

/** The reads a segment's answer is decided from: the transcript held, the segment held at this offset, and the blob's size. */
export const segmentReads = (project: string, g: Pick<SegmentEvent, 'transcriptId' | 'baseOffset' | 'blob'>) =>
  [transcriptRow.bind(project, g.transcriptId), segmentRow.bind(project, g.transcriptId, g.baseOffset), blobSize.bind(project, g.blob)] as const;
