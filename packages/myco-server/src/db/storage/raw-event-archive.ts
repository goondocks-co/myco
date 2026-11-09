import type { RelationalStore } from '../../core/adapters.js';
import { learningHoldsSql } from '../learning/hold.js';
import { effectiveRawOwnerSql } from '../../core/raw-claims.js';
import { first, read, rows } from '../index.js';

/**
 * Hot event bodies and transcript segments due for the archive, read in age order through their due indexes: a page
 * is the same cost however many hot rows exist or how many of them are not due yet.
 */
export interface RawEventCursor { cursor_received: number; cursor_rowid: number; revision: number }
export interface DueRawEvent {
  source_rowid: number; project_id: string; event_id: string; session_id: string; token_id: string;
  raw_revision: number; raw_owner: string | null; raw_provenance: string | null;
  created_at: number; received_at: number; held: number;
}

/**
 * Whether the archive passes a session's raw source by: learning still holds it, or its deletion job is draining it and
 * a new bundle would land in tables the job has already emptied.
 */
const archiveWaitsSql = (project: string, session: string): string =>
  `(${learningHoldsSql(project, session)} OR EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=${project} AND session_id=${session}))`;

const IDENTITY = `e.rowid AS source_rowid,e.project_id,e.event_id,e.session_id,e.token_id,COALESCE(e.raw_revision,0) AS raw_revision,
  c.provenance AS raw_provenance,${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')} AS raw_owner,e.created_at,e.received_at`;

const cursor = read<[], RawEventCursor>({ name: 'storage.rawEventArchiveCursor', sql:
  'SELECT cursor_received,cursor_rowid,revision FROM raw_event_archive_state WHERE id=1' });
export const rawEventArchiveCursor = (db: RelationalStore) => first(db, cursor.bind());

const due = read<[cutoff: number, afterReceived: number, afterRowid: number, limit: number], DueRawEvent>({ name: 'storage.rawEventDuePage', sql:
  `SELECT ${IDENTITY},CASE WHEN ${archiveWaitsSql('e.project_id', 'e.session_id')} THEN 1 ELSE 0 END AS held
    FROM events e INDEXED BY idx_events_hot_received LEFT JOIN raw_credentials c ON c.token_id=e.token_id
    WHERE e.payload_format='inline' AND e.received_at<=?1 AND (e.received_at,e.rowid)>(?2,?3)
    ORDER BY e.received_at,e.rowid LIMIT ?4` });
/** The next page of hot events past the cursor, oldest first, each with whether the archive waits on its session. */
export const dueRawEvents = (db: RelationalStore, position: Pick<RawEventCursor, 'cursor_received' | 'cursor_rowid'>, cutoff: number, limit: number) =>
  rows(db, due.bind(cutoff, position.cursor_received, position.cursor_rowid, limit));

const neighbours = read<[project: string, session: string, createdAt: number, rowid: number, span: number, cutoff: number], DueRawEvent>({ name: 'storage.rawEventSessionDue', sql:
  `SELECT ${IDENTITY},0 AS held
    FROM (SELECT rowid AS rid FROM events INDEXED BY idx_events_session WHERE project_id=?1 AND session_id=?2 AND (created_at,rowid)>=(?3,?4)
      ORDER BY created_at,rowid LIMIT ?5) s
    JOIN events e ON e.rowid=s.rid LEFT JOIN raw_credentials c ON c.token_id=e.token_id
    WHERE e.payload_format='inline' AND e.received_at<=?6 ORDER BY e.created_at,e.rowid` });
/** The due events beside `head` in its session, in session order from it: at most `span` rows of the session are examined. */
export const dueRawEventsBeside = (db: RelationalStore, head: DueRawEvent, span: number, cutoff: number) =>
  rows(db, neighbours.bind(head.project_id, head.session_id, head.created_at, head.source_rowid, span, cutoff));

/** A segment archive row due for the archive, with what decides whether it may go now: whether the archive waits on its session and how far its transcript has published. */
export interface DueSegment {
  project_id: string; source_kind: 'transcript'; source_id: string; session_id: string; size: number; received_at: number;
  transcript_id: string | null; base_offset: number | null; length: number | null; created_at: number | null;
  source_blob_key: string | null; source_generation: string | null; token_id: string; eligible_at: number;
  held: number; published: number;
}

/** The byte a transcript's live publication has reached; -1 while it has none or its publication stopped on a failure. */
export const publishedOffsetSql = (row: string): string => `COALESCE((SELECT p.published_offset FROM session_documents d JOIN transcript_publication p
  ON p.project_id=d.project_id AND p.generation=d.generation AND p.transcript_id=${row}.transcript_id
  WHERE d.project_id=${row}.project_id AND d.session_id=${row}.session_id AND d.state='live' AND p.state<>'failed'),-1)`;

const dueSegmentPage = read<[cutoff: number, received: number, project: string, kind: string, id: string, limit: number], DueSegment>({ name: 'storage.rawSegmentDuePage', sql:
  `SELECT r.project_id,r.source_kind,r.source_id,r.session_id,r.size,r.received_at,r.transcript_id,r.base_offset,r.length,r.created_at,
    r.source_blob_key,r.source_generation,r.token_id,r.eligible_at,
    CASE WHEN ${archiveWaitsSql('r.project_id', 'r.session_id')} THEN 1 ELSE 0 END AS held,${publishedOffsetSql('r')} AS published
    FROM raw_archive_refs r INDEXED BY idx_raw_archive_refs_due WHERE r.disposition='hot' AND r.eligible_at<=?1
      AND (r.eligible_at,r.project_id,r.source_kind,r.source_id)>(?2,?3,?4,?5)
    ORDER BY r.eligible_at,r.project_id,r.source_kind,r.source_id LIMIT ?6` });
/** One page of the transcript due queue past its cursor, with every row's eligibility read in the same statement. */
export const dueSegments = (db: RelationalStore, cutoff: number, after: { received: number; project: string; kind: string; id: string }, limit: number) =>
  rows(db, dueSegmentPage.bind(cutoff, after.received, after.project, after.kind, after.id, limit));
