import type { RelationalStore } from '../../core/adapters.js';
import type { ContentRow } from '../../core/event-content.js';
import { effectiveRawOwnerSql } from '../raw/claims.js';
import { archivedEventPayloadSql } from '../document-tables.js';
import { commit, read, readSet, write, type Bound } from '../index.js';

export interface CleanupState {
  phase: number; cursor_project: string; cursor_id: string; cursor_session: string; cursor_created: number; cursor_rowid: number;
  revision: number; complete: number; paused: number;
  converted_rows: number; cleared_bytes: number; metadata_added_bytes: number; updated_at: number; failure: string | null;
}
export type CleanupCandidate = { project_id: string; resource_id: string; resource_kind: 'event'; session_id?: string; created_at?: number; source_rowid?: number };
export interface CleanupOmissionCursor { project_id: string; resource_kind: string; resource_id: string }

const GUARD = `EXISTS (SELECT 1 FROM storage_cleanup_state WHERE id=1 AND phase=?1 AND cursor_project=?2 AND cursor_id=?3
    AND cursor_session=?4 AND cursor_created=?5 AND cursor_rowid=?6 AND revision=?7 AND paused=0)`;
const guardParams = (state: CleanupState) => [state.phase, state.cursor_project, state.cursor_id, state.cursor_session, state.cursor_created, state.cursor_rowid, state.revision] as const;
/** The guard row refuses a value other than 1, so a moved sweep state aborts the whole page. */
const stateHeld = write<[number, string, string, string, number, number, number]>({ name: 'storage.cleanupStateHeld', sql:
  `INSERT INTO storage_content_guard(ok) SELECT CASE WHEN ${GUARD} THEN 1 ELSE 0 END` });
const stateHeldClear = write<[]>({ name: 'storage.cleanupStateHeldClear', sql: 'DELETE FROM storage_content_guard' });

const state = read<[], CleanupState>({ name: 'storage.cleanupState', sql: 'SELECT * FROM storage_cleanup_state WHERE id=1' });
export async function readCleanupState(db: RelationalStore): Promise<CleanupState | undefined> {
  const [[row]] = await readSet(db, state.bind());
  return row;
}

const queueIdentities = read<[string, string, string, string, number], CleanupCandidate>({ name: 'storage.cleanupQueueIdentities', sql:
  `SELECT project_id,session_id,resource_id,resource_kind FROM storage_cleanup_queue INDEXED BY idx_storage_cleanup_queue_packing
    WHERE (project_id,session_id,resource_kind,resource_id)>(?,?,?,?) ORDER BY project_id,session_id,resource_kind,resource_id LIMIT ?` });
const eventIdentities = read<[string, string, number, number, number], CleanupCandidate>({ name: 'storage.cleanupEventIdentities', sql:
  `SELECT rowid AS source_rowid,project_id,event_id AS resource_id,session_id,created_at,'event' AS resource_kind FROM events INDEXED BY idx_events_session
    WHERE (project_id,session_id,created_at,rowid)>(?,?,?,?) ORDER BY project_id,session_id,created_at,rowid LIMIT ?` });

/** The next identity page of the sweep: queue phases read the queue, event phases walk events in session order. */
export async function cleanupIdentities(db: RelationalStore, current: CleanupState, after: CleanupCandidate | undefined, limit: number): Promise<CleanupCandidate[]> {
  if (current.phase === 2 || current.phase === 4) {
    const [rows] = await readSet(db, queueIdentities.bind(after?.project_id ?? '', after?.session_id ?? '', after?.resource_kind ?? '', after?.resource_id ?? '', limit));
    return rows;
  }
  if (current.phase === 0) return [];
  const [rows] = await readSet(db, eventIdentities.bind(current.cursor_project, current.cursor_session, current.cursor_created, current.cursor_rowid, limit));
  return rows;
}

const CANDIDATE_COLUMNS = `SELECT e.project_id,e.event_id AS resource_id,e.event_id,e.session_id,e.token_id,
    e.content_revision,e.received_at,length(CAST(e.payload AS BLOB)) AS bytes,length(CAST(${archivedEventPayloadSql()} AS BLOB)) AS retained_bytes,e.envelope_hash,COALESCE(e.raw_revision,0) AS raw_revision,
    c.provenance AS raw_provenance,${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')} AS raw_owner
    FROM json_each(?1) j JOIN events e ON e.project_id=json_extract(j.value,'$.project_id') AND e.event_id=json_extract(j.value,'$.resource_id')
    LEFT JOIN raw_credentials c ON c.token_id=e.token_id WHERE e.payload_format='inline'`;
const retentionCandidates = read<[string], ContentRow>({ name: 'storage.cleanupRetentionCandidates', sql: CANDIDATE_COLUMNS });
const sweepCandidates = read<[string], ContentRow>({ name: 'storage.cleanupSweepCandidates', sql:
  `${CANDIDATE_COLUMNS} AND (e.producer_adapter='transcript-parse' OR e.channel='import') AND e.kind IN ('prompt','response','tool.use','tool.failure','plan.snapshot')` });

/** Metadata is read first; exact UTF-8 bodies use a bounded page or checkpointed slices. */
export async function cleanupCandidateRows(db: RelationalStore, ids: readonly CleanupCandidate[], retention: boolean): Promise<ContentRow[]> {
  const page = JSON.stringify(ids.filter(id => id.resource_kind === 'event'));
  const [rows] = await readSet(db, (retention ? retentionCandidates : sweepCandidates).bind(page));
  return rows;
}

const checkpoint = read<[string, string, string, number, string], { scanned_bytes: number }>({ name: 'storage.cleanupScanCheckpoint', sql:
  'SELECT scanned_bytes FROM content_scan_checkpoints WHERE project_id=? AND source_kind=? AND resource_id=? AND content_revision=? AND envelope_hash=?' });
export async function cleanupScanCheckpoint(db: RelationalStore, projectId: string, kind: string, resourceId: string, revision: number, envelopeHash: string): Promise<number | null> {
  const [[row]] = await readSet(db, checkpoint.bind(projectId, kind, resourceId, revision, envelopeHash));
  return row?.scanned_bytes ?? null;
}

const dequeue = write<[string]>({ name: 'storage.cleanupDequeue', sql: `DELETE FROM storage_cleanup_queue WHERE rowid IN
    (SELECT q.rowid FROM json_each(?) j CROSS JOIN storage_cleanup_queue q
      WHERE q.project_id=json_extract(j.value,'$.project_id')
        AND q.resource_kind=json_extract(j.value,'$.resource_kind')
        AND q.resource_id=json_extract(j.value,'$.resource_id'))` });
const advance = write<[number, string, string, string, number, number, number, number, string, string, string, number, number, number, number, number, number, number]>({ name: 'storage.cleanupAdvance', sql:
  `UPDATE storage_cleanup_state SET phase=?8,cursor_project=?9,cursor_id=?10,cursor_session=?11,cursor_created=?12,cursor_rowid=?13,
    revision=revision+1,complete=?14,converted_rows=converted_rows+?15,cleared_bytes=cleared_bytes+?16,
    metadata_added_bytes=metadata_added_bytes+?17,updated_at=?18,failure=NULL WHERE id=1 AND ${GUARD}` });

/** Clear, compact representation, queue release and sweep progress share one commit. */
export async function commitCleanupPage(db: RelationalStore, current: CleanupState, ids: readonly CleanupCandidate[], writes: readonly Bound<never, 'write'>[], now: number,
  converted = 0, cleared = 0, metadata = 0, advancePhase = false): Promise<void> {
  const queue = current.phase === 2 || current.phase === 4;
  const last = ids.at(-1);
  const next = advancePhase ? current.phase + 1 : current.phase;
  const guard = guardParams(current);
  await commit(db,
    stateHeld.bind(...guard), stateHeldClear.bind(), ...writes, dequeue.bind(JSON.stringify(ids)),
    advance.bind(...guard, next,
      advancePhase ? '' : queue ? current.cursor_project : last?.project_id ?? current.cursor_project,
      advancePhase ? '' : queue ? current.cursor_id : last?.resource_id ?? current.cursor_id,
      advancePhase ? '' : queue ? current.cursor_session : last?.session_id ?? current.cursor_session,
      advancePhase ? -1 : queue ? current.cursor_created : last?.created_at ?? current.cursor_created,
      advancePhase ? -1 : queue ? current.cursor_rowid : last?.source_rowid ?? current.cursor_rowid,
      next === 4 ? 1 : 0, converted, cleared, metadata, now));
}

const omit = write<[now: number, items: string]>({ name: 'storage.cleanupOmissions', sql:
  `INSERT INTO storage_cleanup_omissions(project_id,resource_kind,resource_id,reason,observed_at)
    SELECT json_extract(value,'$.project_id'),json_extract(value,'$.kind'),json_extract(value,'$.resource_id'),
      'retained-inline:net-gain',? FROM json_each(?) WHERE true
    ON CONFLICT(project_id,resource_kind,resource_id) DO UPDATE SET reason=excluded.reason,observed_at=excluded.observed_at` });
export const cleanupOmissionStatement = (_db: RelationalStore, now: number, items: string): Bound<never, 'write'> => omit.bind(now, items);

const setPaused = write<[paused: number, now: number], { id: number }>({ name: 'storage.cleanupSetPaused', sql:
  'UPDATE storage_cleanup_state SET paused=?,revision=revision+1,updated_at=? WHERE id=1 RETURNING id' });
/** Answers false when the state row is missing. */
export async function setCleanupPaused(db: RelationalStore, paused: boolean, now: number): Promise<boolean> {
  const [result] = await commit(db, setPaused.bind(paused ? 1 : 0, now));
  return result.results.length === 1;
}

const omissionsPage = read<[string, string, string, number], CleanupOmissionCursor & { retained: number }>({ name: 'storage.cleanupRetainedInline', sql:
  `WITH page AS MATERIALIZED (
    SELECT project_id,resource_kind,resource_id,reason FROM storage_cleanup_omissions
    WHERE (project_id,resource_kind,resource_id)>(?,?,?) ORDER BY project_id,resource_kind,resource_id LIMIT ?)
    SELECT p.project_id,p.resource_kind,p.resource_id,
      p.reason='retained-inline:net-gain' AND CASE p.resource_kind
        WHEN 'event' THEN EXISTS(SELECT 1 FROM events e WHERE e.project_id=p.project_id AND e.event_id=p.resource_id AND e.payload_format='inline')
 ELSE 0 END AS retained
    FROM page p ORDER BY p.project_id,p.resource_kind,p.resource_id` });
export async function readCleanupOmissions(db: RelationalStore, after: CleanupOmissionCursor | undefined, limit: number) {
  const [rows] = await readSet(db, omissionsPage.bind(after?.project_id ?? '', after?.resource_kind ?? '', after?.resource_id ?? '', limit));
  return rows;
}

const eventOrQueued = read<[], { pending: number }>({ name: 'storage.cleanupSweepPending', sql:
  'SELECT 1 AS pending WHERE EXISTS(SELECT 1 FROM events LIMIT 1) OR EXISTS(SELECT 1 FROM storage_cleanup_queue LIMIT 1)' });
const queued = read<[], { pending: number }>({ name: 'storage.cleanupQueuePending', sql: 'SELECT 1 AS pending FROM storage_cleanup_queue LIMIT 1' });
export async function cleanupWorkPending(db: RelationalStore, complete: boolean): Promise<boolean> {
  const [rows] = await readSet(db, (complete ? queued : eventOrQueued).bind());
  return rows.length > 0;
}
