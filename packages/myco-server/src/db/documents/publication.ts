import { prepareBound } from '../kernel/statement.js';
import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, read, readSet, write } from '../index.js';

export interface DueSession { project_id: string; session_id: string; revision: number; due_at: number }
export const PUBLISH_BACKOFF_MIN_MS = 60_000;
export const PUBLISH_BACKOFF_MAX_MS = 30 * 60_000;

const due = read<[number, number, number], DueSession>({ name: 'publication.dueSessions', sql: `SELECT q.project_id,q.session_id,d.publication_input_revision AS revision,q.due_at
  FROM document_due q CROSS JOIN session_documents d ON (d.project_id,d.session_id)=(q.project_id,q.session_id)
  WHERE q.imported=?1 AND q.due_at<=?2
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(q.project_id,q.session_id))
  ORDER BY q.due_at,q.project_id,q.session_id LIMIT ?3` });
const defer = write<[string, string, number, number]>({ name: 'publication.deferUnchangedInput', sql: `UPDATE session_documents
  SET due_at=?3+MIN(MAX(?3-updated_at,${PUBLISH_BACKOFF_MIN_MS}),${PUBLISH_BACKOFF_MAX_MS})
  WHERE project_id=?1 AND session_id=?2 AND state='live' AND publication_input_revision=?4
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)` });

export async function dueSessions(db: RelationalStore, now: number, limit: number): Promise<DueSession[]> {
  const arms = await readSet(db, due.bind(0, now, limit), due.bind(1, now, limit));
  return arms.flat().sort((a, b) => a.due_at - b.due_at || (a.project_id < b.project_id ? -1 : a.project_id > b.project_id ? 1 : 0)
    || (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0)).slice(0, limit);
}

export async function deferFailedPublication(db: RelationalStore, ref: DueSession, now: number): Promise<void> {
  await commit(db, defer.bind(ref.project_id, ref.session_id, now, ref.revision));
}

const settle = write<[string, string, string | null, number | null, number | null]>({ name: 'publication.settleDirectory', sql: `UPDATE session_documents SET
  publication_after=CASE WHEN publication_pass_changed THEN NULL ELSE ?3 END,
  publication_scan_due=CASE WHEN publication_pass_changed THEN NULL ELSE ?4 END,
  due_at=CASE WHEN publication_pass_changed THEN 0 ELSE (SELECT MIN(due) FROM (SELECT ?5 AS due UNION ALL
    SELECT 0 WHERE EXISTS(SELECT 1 FROM publish_queue WHERE project_id=?1 AND session_id=?2 AND failure IS NULL AND retry_cause IS NULL)
    UNION ALL SELECT (SELECT retry_at FROM publish_queue WHERE project_id=?1 AND session_id=?2 AND failure IS NULL AND retry_cause IS NOT NULL ORDER BY retry_at,rank,created_at,event_id LIMIT 1))) END
  WHERE project_id=?1 AND session_id=?2` });

export function settlePublication(db: RelationalStore, project: string, session: string, after: string | null, scanDue: number | null, dueAt: number | null) {
  return prepareBound(db, settle.bind(project, session, after, scanDue, dueAt));
}

interface PublicationObservation {
  project: string; session: string; generation: number; nextChunk: number; revision: number; after: string | null;
  chunks: string; offsets: string; queue: string; queued: number;
}
const unchanged = assertion<[string, string, number, number, number, string | null, string, string, string, number]>({
  name: 'publication.directoryUnchanged', sql: `SELECT CASE WHEN
    EXISTS (SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND state='live' AND generation=?3
      AND next_chunk=?4 AND (publication_after IS ?6 OR publication_input_revision<>?5))
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
    AND NOT EXISTS (SELECT 1 FROM json_each(?7) j LEFT JOIN session_chunks c ON c.project_id=?1 AND c.session_id=?2 AND c.generation=?3
      AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))
    AND NOT EXISTS (SELECT 1 FROM json_each(?8) j LEFT JOIN transcript_publication t ON t.project_id=?1 AND t.generation=?3
      AND t.transcript_id=json_extract(j.value,'$.t') WHERE t.published_offset IS NOT json_extract(j.value,'$.o'))
    AND (SELECT COUNT(*) FROM json_each(?9) j JOIN publish_queue q ON q.project_id=?1 AND q.session_id=?2 AND q.rank=json_extract(j.value,'$.r')
      AND q.created_at=json_extract(j.value,'$.c') AND q.event_id=json_extract(j.value,'$.e')
      AND q.failure IS NULL AND q.retry_at=json_extract(j.value,'$.t') AND q.retry_cause IS json_extract(j.value,'$.w'))=?10
    THEN 1 ELSE json_extract('[]','$[publication_input_changed]') END` });

const observeInput = write<[string, string, number]>({ name: 'publication.observeCommitInput', sql: `UPDATE session_documents
  SET publication_pass_changed=(publication_input_revision<>?3) WHERE project_id=?1 AND session_id=?2` });

export function publicationGuard(db: RelationalStore, held: PublicationObservation) {
  return [prepareBound(db, unchanged.bind(held.project, held.session, held.generation, held.nextChunk, held.revision,
    held.after, held.chunks, held.offsets, held.queue, held.queued)), prepareBound(db, observeInput.bind(held.project, held.session, held.revision))];
}

const published = write<[string, string, number]>({ name: 'publication.advancePublishedRevision', sql: `UPDATE session_documents
  SET published_revision=published_revision+1 WHERE project_id=?1 AND session_id=?2 AND generation=?3 AND state='live'` });

/** Every committed live chunk layout advances the session's published revision. */
export function publishedDocument(db: RelationalStore, project: string, session: string, generation: number) {
  return prepareBound(db, published.bind(project, session, generation));
}
