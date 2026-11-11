import { binaryOrder } from '../../read/scope.js';
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

type EdgeRequest = { projectId: string; sessionId: string; type?: SessionEdgeType; after: { at: number; id: string } | null; limit: number };
const childPages = (edge: 'child' | 'continued_by') => {
  const operation = edge === 'child' ? 'children' : 'continuations';
  const type = edge === 'child' ? 'child_session' : 'continuation';
  const index = edge === 'child' ? 'idx_sessions_launch_activity' : 'idx_sessions_parent_activity';
  const parent = edge === 'child' ? 'launch_parent_session_id' : 'parent_session_id';
  const at = occurredAt('r.');
  const sql = (boundary: string) => `SELECT ${columns(type, edge, 'r.session_id', at, edge === 'child' ? 'NULL' : 'r.parent_reason')}
    FROM sessions r INDEXED BY ${index} WHERE r.project_id=?1 AND r.${parent}=?2 ${boundary} AND ${notTombstonedSql('r')}
    ORDER BY ${at} DESC,r.session_id DESC LIMIT ?3`;
  type First = [project: string, session: string, limit: number];
  type At = [...First, at: number];
  const first = read<First, SessionEdgeRow>({ name: `sessionEdges.${operation}First`, sql: sql('') });
  const earlier = read<At, SessionEdgeRow>({ name: `sessionEdges.${operation}Earlier`, sql: sql(`AND ${at}<?4`) });
  const through = read<At, SessionEdgeRow>({ name: `sessionEdges.${operation}Through`, sql: sql(`AND ${at}<=?4`) });
  const after = read<[...At, sessionKey: string], SessionEdgeRow>({ name: `sessionEdges.${operation}After`, sql: sql(`AND (${at},r.session_id)<(?4,?5)`) });
  return (request: EdgeRequest) => {
    const keys: First = [request.projectId, request.sessionId, request.limit];
    const key = request.after;
    if (key === null) return first.bind(...keys);
    const prefix = `${edge}:`;
    if (key.id.startsWith(prefix)) return after.bind(...keys, key.at, key.id.slice(prefix.length));
    return (binaryOrder(prefix, key.id) < 0 ? through : earlier).bind(...keys, key.at);
  };
};
const CHILDREN = childPages('child');
const CONTINUATIONS = childPages('continued_by');
const PARENT = read<[project: string, session: string], SessionEdgeRow>({ name: 'sessionEdges.parent', sql:
  `SELECT ${columns('continuation', 'continues', 's.parent_session_id', occurredAt('s.'), 's.parent_reason')}
    FROM sessions s LEFT JOIN sessions r ON r.project_id=s.project_id AND r.session_id=s.parent_session_id AND ${notTombstonedSql('r')}
    WHERE s.project_id=?1 AND s.session_id=?2 AND s.parent_session_id IS NOT NULL` });

/** Each edge family contributes a bounded page in displayed order; the merged page keeps the same order across families. */
export async function readSessionEdges(db: RelationalStore, request: EdgeRequest): Promise<SessionEdgeRow[]> {
  const { type, after, limit } = request;
  const pages = await readSet(db,
    ...(type === 'continuation' ? [] : [CHILDREN(request)]),
    ...(type === 'child_session' ? [] : [CONTINUATIONS(request), PARENT.bind(request.projectId, request.sessionId)]));
  return pages.flat().filter(row => after === null || row.at < after.at || (row.at === after.at && binaryOrder(row.id, after.id) < 0))
    .sort((a, b) => b.at - a.at || binaryOrder(b.id, a.id)).slice(0, limit);
}
