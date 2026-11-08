import type { RelationalStore } from '../../core/adapters.js';
import { commit, read, readSet, write } from '../index.js';

export interface DueSession { project_id: string; session_id: string; revision: number }
export const PUBLISH_BACKOFF_MIN_MS = 60_000;
export const PUBLISH_BACKOFF_MAX_MS = 30 * 60_000;

const due = read<[number, number], DueSession>({ name: 'publication.dueSessions', sql: `SELECT d.project_id,d.session_id,d.publication_input_revision AS revision
  FROM session_documents d WHERE d.due_at<=? AND d.state='live'
    AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE (t.project_id,t.session_id)=(d.project_id,d.session_id))
  ORDER BY d.due_at,d.project_id,d.session_id LIMIT ?` });
const defer = write<[string, string, number, number]>({ name: 'publication.deferUnchangedInput', sql: `UPDATE session_documents
  SET due_at=?3+MIN(MAX(?3-updated_at,${PUBLISH_BACKOFF_MIN_MS}),${PUBLISH_BACKOFF_MAX_MS})
  WHERE project_id=?1 AND session_id=?2 AND state='live' AND publication_input_revision=?4
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)` });

export async function dueSessions(db: RelationalStore, now: number, limit: number): Promise<DueSession[]> {
  const [rows] = await readSet(db, due.bind(now, limit));
  return rows;
}

export async function deferFailedPublication(db: RelationalStore, ref: DueSession, now: number): Promise<void> {
  await commit(db, defer.bind(ref.project_id, ref.session_id, now, ref.revision));
}
