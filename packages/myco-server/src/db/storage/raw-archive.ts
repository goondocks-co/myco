/**
 * The raw archive's cursors and the statements that move a hot source to its archived representation. Every page commits
 * its source changes with the cursor advance, and each advance holds only while the cursor is exactly as read.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { effectiveRawOwnerSql } from '../../core/raw-claims.js';
import { clearArchivedTranscriptRanges } from '../documents/ranges.js';
import { commit, first, read, rows, write, type Bound } from '../index.js';
import { learningHoldsSql } from '../learning/hold.js';
import { contentGuard } from './content-guard.js';
import { publishedOffsetSql } from './raw-event-archive.js';

type Guard = { sql: string; params: readonly unknown[] };

export interface RawArchiveState { phase: number; cursor_project: string; cursor_id: string; cursor_offset: number; due_received: number; due_kind: string; revision: number }
export interface RawEventPosition { cursor_received: number; cursor_rowid: number }

const state = read<[], RawArchiveState>({ name: 'rawArchive.state', sql:
  `SELECT phase,cursor_project,cursor_id,cursor_offset,due_received,due_kind,revision
  FROM raw_archive_state WHERE id=1` });
export const readRawArchiveState = (db: RelationalStore): Promise<RawArchiveState | null> => first(db, state.bind());

const STATE_HELD = `EXISTS (SELECT 1 FROM raw_archive_state WHERE id=1 AND phase=?
  AND cursor_project=? AND cursor_id=? AND cursor_offset=? AND due_received=? AND due_kind=? AND revision=?)`;
const stateParams = (s: RawArchiveState) => [s.phase, s.cursor_project, s.cursor_id, s.cursor_offset, s.due_received, s.due_kind, s.revision] as const;

const advanceState = write<[phase: number, project: string, id: string, offset: number, received: number, kind: string,
  heldPhase: number, heldProject: string, heldId: string, heldOffset: number, heldReceived: number, heldKind: string, heldRevision: number], { revision: number }>({
  name: 'rawArchive.advance', sql:
  `UPDATE raw_archive_state SET phase=?1,cursor_project=?2,cursor_id=?3,cursor_offset=?4,due_received=?5,due_kind=?6,
      revision=revision+1,complete=0 WHERE id=1 AND phase=?7 AND cursor_project=?8 AND cursor_id=?9
      AND cursor_offset=?10 AND due_received=?11 AND due_kind=?12 AND revision=?13 RETURNING revision` });

/** Source changes and the cursor advance commit together; false when the cursor moved. */
export async function commitRawArchivePage(db: RelationalStore, s: RawArchiveState, next: Partial<RawArchiveState>, writes: readonly Bound<never, 'write'>[]): Promise<boolean> {
  const held = stateParams(s);
  const results = await commit(db, ...contentGuard(STATE_HELD, held), ...writes,
    advanceState.bind(next.phase ?? s.phase, next.cursor_project ?? s.cursor_project, next.cursor_id ?? s.cursor_id,
      next.cursor_offset ?? s.cursor_offset, next.due_received ?? s.due_received, next.due_kind ?? s.due_kind, ...held));
  return results.at(-1)?.results.length === 1;
}

const segmentPage = read<[project: string, transcript: string, offset: number, limit: number], { project_id: string; transcript_id: string; base_offset: number }>({
  name: 'rawArchive.segmentPage', sql:
  `SELECT project_id,transcript_id,base_offset FROM transcript_segments
    WHERE (project_id,transcript_id,base_offset)>(?1,?2,?3) ORDER BY project_id,transcript_id,base_offset LIMIT ?4` });
/** Segment identities after the cursor, in numeric-offset order. */
export const segmentsAfter = (db: RelationalStore, s: RawArchiveState, limit: number) =>
  rows(db, segmentPage.bind(s.cursor_project, s.cursor_id, s.cursor_offset, limit));

const seedRef = write<[project: string, transcript: string, offset: number]>({ name: 'rawArchive.seedSegmentRef', sql:
  `INSERT INTO raw_archive_refs
      (project_id,source_kind,source_id,session_id,size,received_at,transcript_id,base_offset,length,
       created_at,source_blob_key,token_id,source_generation,eligible_at)
      SELECT x.project_id,'transcript',x.transcript_id || ':' || x.base_offset,t.session_id,x.length,x.received_at,
        x.transcript_id,x.base_offset,x.length,x.created_at,x.blob_key,x.token_id,b.generation,x.received_at
      FROM transcript_segments x JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
      JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
      WHERE x.project_id=?1 AND x.transcript_id=?2 AND x.base_offset=?3 ON CONFLICT DO NOTHING` });
/** A historical segment's hot ref, seeded while the segment, its transcript and its blob are all held. */
export function seedSegmentRef(id: { project_id: string; transcript_id: string; base_offset: number }): Bound<never, 'write'>[] {
  return [
    ...contentGuard(`EXISTS (SELECT 1 FROM transcript_segments x JOIN transcripts t
      ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id JOIN blobs b
      ON b.project_id=x.project_id AND b.key=x.blob_key WHERE x.project_id=? AND x.transcript_id=? AND x.base_offset=?)`,
    [id.project_id, id.transcript_id, id.base_offset]),
    seedRef.bind(id.project_id, id.transcript_id, id.base_offset),
  ];
}

export interface SegmentSource {
  event_id: string; blob_key: string; length: number; created_at: number; received_at: number; token_id: string;
  envelope_hash: string; published: number; generation: string | null;
}
const segmentSource = read<[project: string, transcript: string, offset: number], SegmentSource>({ name: 'rawArchive.segmentSource', sql:
  `SELECT x.event_id,x.blob_key,x.length,x.created_at,x.received_at,x.token_id,
    e.envelope_hash,${publishedOffsetSql('t')} AS published,b.generation FROM transcript_segments x
    JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
    JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
    JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
    WHERE x.project_id=?1 AND x.transcript_id=?2 AND x.base_offset=?3` });
export const readSegmentSource = (db: RelationalStore, project: string, transcript: string, offset: number): Promise<SegmentSource | null> =>
  first(db, segmentSource.bind(project, transcript, offset));

const archiveRef = write<[archive: string, receipt: string, digest: string, size: number, project: string, source: string]>({ name: 'rawArchive.archiveSegmentRef', sql:
  `UPDATE raw_archive_refs SET archive_key=?1,receipt_key=?2,digest=?3,size=?4,disposition='archived'
      WHERE project_id=?5 AND source_kind='transcript' AND source_id=?6 AND disposition='hot'` });

export interface SegmentArchive {
  projectId: string; sessionId: string; sourceId: string; transcriptId: string; baseOffset: number;
  cutoff: number; envelopeHash: string;
  body: { key: string; digest: string; size: number }; receiptKey: string;
  /** The retention policy as observed, and the body's and receipt's verified-content conditions. */
  policy: Guard; bodyProof: Guard; receiptProof: Guard;
}

/**
 * A published segment's registered generation becomes its archived locator: guarded by the policy as observed, both
 * proofs, no open hold or learning hold, a live session and the hot ref as read; its hot range is cleared in the same
 * transaction and the archived ref must then stand with the segment gone.
 */
export function segmentArchive(a: SegmentArchive): Bound<never, 'write'>[] {
  const guard = `${a.policy.sql} AND ${a.bodyProof.sql} AND ${a.receiptProof.sql}
    AND NOT EXISTS (SELECT 1 FROM recovery_holds WHERE released_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM (SELECT ? AS project_id, ? AS session_id) learning_source
      WHERE ${learningHoldsSql('learning_source.project_id', 'learning_source.session_id')})
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=? AND session_id=?)
    AND EXISTS (SELECT 1 FROM raw_archive_refs r JOIN transcript_segments x
      ON x.project_id=r.project_id AND x.transcript_id=r.transcript_id AND x.base_offset=r.base_offset
      JOIN transcripts t ON t.project_id=x.project_id AND t.transcript_id=x.transcript_id
      JOIN blobs b ON b.project_id=x.project_id AND b.key=x.blob_key
      JOIN events e ON e.project_id=x.project_id AND e.event_id=x.event_id
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='hot'
        AND r.received_at<=? AND r.source_blob_key=x.blob_key AND r.source_generation IS b.generation
        AND r.length=x.length AND r.created_at=x.created_at AND r.token_id=x.token_id
        AND e.envelope_hash=? AND ${publishedOffsetSql('t')}>=x.base_offset+x.length)`;
  return [
    ...contentGuard(guard, [...a.policy.params, ...a.bodyProof.params, ...a.receiptProof.params,
      a.projectId, a.sessionId, a.projectId, a.sessionId, a.projectId, a.sourceId, a.cutoff, a.envelopeHash]),
    archiveRef.bind(a.body.key, a.receiptKey, a.body.digest, a.body.size, a.projectId, a.sourceId),
    clearArchivedTranscriptRanges(a.projectId, a.transcriptId, a.baseOffset),
    ...contentGuard(`EXISTS (SELECT 1 FROM raw_archive_refs r JOIN blobs b
      ON b.project_id=r.project_id AND b.key=r.archive_key AND b.size=r.size
      WHERE r.project_id=? AND r.source_kind='transcript' AND r.source_id=? AND r.disposition='archived'
        AND r.archive_key=? AND r.receipt_key=?) AND NOT EXISTS
      (SELECT 1 FROM transcript_segments WHERE project_id=? AND transcript_id=? AND base_offset=?)`,
    [a.projectId, a.sourceId, a.body.key, a.receiptKey, a.projectId, a.transcriptId, a.baseOffset]),
  ];
}

const RAW_EVENT_STATE_HELD = `EXISTS (SELECT 1 FROM raw_event_archive_state WHERE id=1
  AND cursor_received=? AND cursor_rowid=? AND revision=?)`;
const advanceRawEvents = write<[received: number, rowid: number, heldReceived: number, heldRowid: number, heldRevision: number], { revision: number }>({
  name: 'rawArchive.advanceEvents', sql:
  `UPDATE raw_event_archive_state SET cursor_received=?1,cursor_rowid=?2,revision=revision+1
        WHERE id=1 AND cursor_received=?3 AND cursor_rowid=?4 AND revision=?5 RETURNING revision` });

/**
 * The event cursor moves to `last` (or back to the start) with `writes`, while the cursor is as read and, where `policy`
 * is given, the retention policy is as observed; false when the cursor moved.
 */
export async function commitRawEventPage(db: RelationalStore, held: RawEventPosition & { revision: number },
  last: { received_at: number; source_rowid: number } | null, writes: readonly Bound<never, 'write'>[], policy: Guard | null): Promise<boolean> {
  const params = [held.cursor_received, held.cursor_rowid, held.revision] as const;
  const results = await commit(db,
    ...contentGuard(policy === null ? RAW_EVENT_STATE_HELD : `${RAW_EVENT_STATE_HELD} AND ${policy.sql}`, policy === null ? params : [...params, ...policy.params]),
    ...writes,
    advanceRawEvents.bind(last?.received_at ?? -1, last?.source_rowid ?? -1, ...params));
  return results.at(-1)?.results.length === 1;
}

const SOURCES_DUE = `NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN events e
    ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.event_id')
    LEFT JOIN raw_credentials c ON c.token_id=e.token_id
    WHERE e.event_id IS NULL OR e.session_id<>json_extract(j.value,'$.session_id')
      OR e.token_id<>json_extract(j.value,'$.token_id')
      OR COALESCE(e.raw_revision,0)<>json_extract(j.value,'$.raw_revision')
      OR e.received_at<>json_extract(j.value,'$.received_at') OR e.received_at>?
      OR e.payload_format<>'inline' OR c.provenance IS NOT json_extract(j.value,'$.raw_provenance')
      OR ${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
        IS NOT json_extract(j.value,'$.raw_owner'))`;
const SOURCES_UNHELD = `NOT EXISTS (SELECT 1 FROM json_each(?) j
      WHERE ${learningHoldsSql("json_extract(j.value,'$.project_id')", "json_extract(j.value,'$.session_id')")})`;

/** The selected raw events are still unheld by learning, and still the inline revisions read, received by `cutoff`. */
export function rawEventsStillDue(identities: string, cutoff: number): Bound<never, 'write'>[] {
  return [...contentGuard(SOURCES_UNHELD, [identities]), ...contentGuard(SOURCES_DUE, [identities, cutoff])];
}
