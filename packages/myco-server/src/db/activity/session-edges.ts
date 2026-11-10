import type { RelationalStore } from '../../core/adapters.js';
import { occurredAt } from '../session-dates.js';
import { notTombstonedSql } from '../session-read-model.js';
import { firstPromptSql } from '../sessions/browse.js';
import { read, readSet } from '../index.js';

/** The edges a session stands in: a child it launched, a session continuing its conversation, and the one it continues. */
export type SessionEdge = 'child' | 'continued_by' | 'continues';
export type SessionEdgeType = 'child_session' | 'continuation';

/** One edge as read: its order and the related session `r` it names, null when this Project does not hold that session. */
export interface SessionEdgeRow {
  type: SessionEdgeType; edge: SessionEdge; id: string; at: number;
  related: string | null; title: string | null; first_prompt: string | null; agent: string | null; reason: string | null;
}

const columns = (type: SessionEdgeType, edge: SessionEdge, related: string, at: string, reason: string) =>
  `'${type}' AS type,'${edge}' AS edge,'${edge}:' || ${related} AS id,${at} AS at,r.session_id AS related,r.title AS title,
    ${firstPromptSql('r')} AS first_prompt,r.agent AS agent,${reason} AS reason`;

/** Each term binds the Project as `?1` and the session as `?2`. */
const TERMS: Readonly<Record<SessionEdgeType, readonly string[]>> = {
  child_session: [
    `SELECT ${columns('child_session', 'child', 'r.session_id', occurredAt('r.'), 'NULL')}
      FROM sessions r INDEXED BY idx_sessions_launch_parent WHERE r.project_id=?1 AND r.launch_parent_session_id=?2 AND ${notTombstonedSql('r')}`,
  ],
  continuation: [
    `SELECT ${columns('continuation', 'continued_by', 'r.session_id', occurredAt('r.'), 'r.parent_reason')}
      FROM sessions r INDEXED BY idx_sessions_parent WHERE r.project_id=?1 AND r.parent_session_id=?2 AND ${notTombstonedSql('r')}`,
    `SELECT ${columns('continuation', 'continues', 's.parent_session_id', occurredAt('s.'), 's.parent_reason')}
      FROM sessions s LEFT JOIN sessions r ON r.project_id=s.project_id AND r.session_id=s.parent_session_id AND ${notTombstonedSql('r')}
      WHERE s.project_id=?1 AND s.session_id=?2 AND s.parent_session_id IS NOT NULL`,
  ],
};

const edgeSql = (terms: readonly string[], after: boolean) => `SELECT e.type,e.edge,e.id,e.at,e.related,e.title,e.first_prompt,e.agent,e.reason
  FROM (${terms.join(' UNION ALL ')}) e ${after ? 'WHERE e.at<=?4 AND (e.at<?4 OR (e.at=?4 AND e.id<?5))' : ''} ORDER BY e.at DESC,e.id DESC LIMIT ?3`;

type First = [project: string, session: string, limit: number];
type After = [...First, at: number, id: string];
const statements = (name: string, terms: readonly string[]) => ({
  first: read<First, SessionEdgeRow>({ name: `sessionEdges.${name}First`, sql: edgeSql(terms, false) }),
  after: read<After, SessionEdgeRow>({ name: `sessionEdges.${name}After`, sql: edgeSql(terms, true) }),
});
const EDGES = {
  all: statements('all', [...TERMS.child_session, ...TERMS.continuation]),
  child_session: statements('children', TERMS.child_session),
  continuation: statements('continuations', TERMS.continuation),
};

/** At most `limit` edges of the session, newest first after `(at, id)`, of one type or of every type. */
export async function readSessionEdges(db: RelationalStore, request: {
  projectId: string; sessionId: string; type?: SessionEdgeType; after: { at: number; id: string } | null; limit: number;
}): Promise<SessionEdgeRow[]> {
  const pages = EDGES[request.type ?? 'all'];
  const [rows] = await readSet(db, request.after === null ? pages.first.bind(request.projectId, request.sessionId, request.limit)
    : pages.after.bind(request.projectId, request.sessionId, request.limit, request.after.at, request.after.id));
  return rows;
}
