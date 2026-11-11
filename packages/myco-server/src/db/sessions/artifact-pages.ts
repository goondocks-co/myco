import type { RelationalStore } from '../../core/adapters.js';
import { ARTIFACT_COLUMNS, type SessionArtifactRow } from '../../core/session-artifacts.js';
import { read, readSet } from '../index.js';

const SELECT = `SELECT ${ARTIFACT_COLUMNS} FROM session_artifacts WHERE project_id = ?1 AND session_id = ?2`;
const first = read<[project: string, session: string, limit: number], SessionArtifactRow>({ name: 'sessionArtifacts.first', sql:
  `${SELECT} ORDER BY reported_at, id LIMIT ?3` });
const after = read<[project: string, session: string, limit: number, at: number, id: string], SessionArtifactRow>({ name: 'sessionArtifacts.after', sql:
  `${SELECT} AND reported_at >= ?4 AND (reported_at > ?4 OR (reported_at = ?4 AND id > ?5)) ORDER BY reported_at, id LIMIT ?3` });

/** Up to `limit` of the artifacts a session reported, oldest first, after the key `(reportedAt, id)` when one is given. */
export async function sessionArtifactPage(db: RelationalStore, request: { project: string; session: string; limit: number; after: { createdAt: number; id: string } | null }): Promise<SessionArtifactRow[]> {
  const { project, session, limit } = request;
  const [rows] = await readSet(db, request.after === null ? first.bind(project, session, limit) : after.bind(project, session, limit, request.after.createdAt, request.after.id));
  return rows;
}
