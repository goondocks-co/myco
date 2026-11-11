import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';

const tombstoned = read<[project: string, sessions: string], { session_id: string }>({ name: 'tombstone.among', sql:
  'SELECT t.session_id FROM json_each(?2) s CROSS JOIN session_tombstones t ON t.project_id=?1 AND t.session_id=s.value' });

/** Which of these sessions this Project has deleted. The set an import checks before it offers anything: a tombstoned session is never held again. */
export async function tombstonedAmong(db: RelationalStore, projectId: string, sessionIds: readonly string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const [rows] = await readSet(db, tombstoned.bind(projectId, JSON.stringify(sessionIds)));
  return new Set(rows.map(row => row.session_id));
}

const present = read<[project: string, session: string], { present: number }>({ name: 'tombstone.sessionPresent', sql:
  'SELECT 1 AS present FROM sessions WHERE project_id=?1 AND session_id=?2' });

/** True when the Project holds this session at all, tombstoned or not: what separates "already deleted" from "never here". */
export async function sessionPresent(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const [rows] = await readSet(db, present.bind(projectId, sessionId));
  return rows.length === 1;
}

const isTombstonedRead = read<[project: string, session: string], { present: number }>({ name: 'tombstone.present', sql:
  'SELECT 1 AS present FROM session_tombstones WHERE project_id=?1 AND session_id=?2' });

/** Whether this session carries a tombstone. */
export async function isTombstoned(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const [rows] = await readSet(db, isTombstonedRead.bind(projectId, sessionId));
  return rows.length === 1;
}

const clearOwnFacts = write<[project: string, session: string]>({ name: 'tombstone.clearSessionFacts', sql:
  `UPDATE sessions SET title=NULL,summary=NULL,titled_at=NULL,titled_by=NULL
    WHERE project_id=?1 AND session_id=?2 AND (title IS NOT NULL OR summary IS NOT NULL OR titled_at IS NOT NULL OR titled_by IS NOT NULL)` });
const clearDeletedParents = write<[project: string, sessions: string]>({ name: 'tombstone.clearDeletedParents', sql:
  `UPDATE sessions SET parent_session_id=NULL,parent_reason=NULL,launch_parent_session_id=NULL
    WHERE project_id=?1 AND session_id IN (SELECT value FROM json_each(?2))
      AND (parent_session_id IS NOT NULL OR parent_reason IS NOT NULL OR launch_parent_session_id IS NOT NULL)
      AND EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=sessions.project_id AND t.session_id=sessions.session_id)` });

/** What the session says of itself, cleared: a surviving session that names it as a parent keeps that reference. */
export const sessionFactsCleared = (projectId: string, sessionId: string): Bound[] => [
  clearOwnFacts.bind(projectId, sessionId),
  clearDeletedParents.bind(projectId, JSON.stringify([sessionId])),
];

/**
 * The one clear of deleted sessions' own parents, for every session among `sessionIds` that carries a tombstone. Each
 * writer of deleted-session state (deletion, and restore of `sessions` or `session_tombstones` rows) runs it in the batch
 * that writes that state, so a deleted session never stays in the parent indexes.
 */
export function clearDeletedParentsStatement(projectId: string, sessionIds: readonly string[]): Bound<never, 'write'> {
  return clearDeletedParents.bind(projectId, JSON.stringify(sessionIds));
}
