import type { RelationalStore } from '../../core/adapters.js';
import { clampLimit, decodeCursor, type ReadScope } from '../scope.js';
import { readSessionEdges, type SessionEdge } from '../../db/activity/session-edges.js';
import { sessions_relatedSessionLabel } from './sessions.js';

export const SESSION_ACTIVITY_TYPES = ['child_session', 'continuation'] as const;

type session_activity_SessionActivityType = typeof SESSION_ACTIVITY_TYPES[number];

interface session_activity_SessionActivityRow {
  id: string;
  type: session_activity_SessionActivityType;
  title: string;
  detail: string;
  at: number;
  /** The related session a row opens; null for a session this Project does not hold. */
  sessionId: string | null;
  /** The related session's agent. */
  agent: string | null;
}

interface session_activity_SessionActivityOptions {
  type?: session_activity_SessionActivityType;
  limit?: number;
  cursor?: string;
}

const session_activity_EDGE_DETAILS: Readonly<Record<SessionEdge, string>> = {
  child: 'Child of this session',
  continued_by: 'Continues this session’s conversation',
  continues: 'This session continues its conversation',
};

/** The title of a session row whose related session this Project does not hold. */
const session_activity_NOT_CAPTURED_TITLE = 'A session not captured here';

/**
 * A session's parent edges of the named type, as activity rows, newest first after the cursor: a child it launched, at
 * the child's start; a session that continues its conversation, at that session's start; and the conversation it
 * continues, at its own start. At most `limit` + 1 rows, so a caller sees whether more follow; a cursor that is not one
 * reads nothing.
 */
async function session_activity_sessionEdges(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: session_activity_SessionActivityOptions = {}): Promise<session_activity_SessionActivityRow[]> {
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return [];
  const rows = await readSessionEdges(db, { projectId: scope.projectId, sessionId, ...(opts.type === undefined ? {} : { type: opts.type }),
    after: after === null ? null : { at: after.createdAt, id: after.id }, limit: clampLimit(opts.limit) + 1 });
  return rows.map((row): session_activity_SessionActivityRow => ({
    id: row.id, type: row.type, at: row.at,
    title: row.related === null ? session_activity_NOT_CAPTURED_TITLE : sessions_relatedSessionLabel(row.title, row.first_prompt, row.agent),
    detail: [session_activity_EDGE_DETAILS[row.edge], row.reason].filter(Boolean).join(' · '),
    sessionId: row.related, agent: row.agent,
  }));
}

export { type session_activity_SessionActivityType, type session_activity_SessionActivityRow, type session_activity_SessionActivityOptions, session_activity_sessionEdges };
