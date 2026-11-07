import type { RelationalStore as session_activity_import_RelationalStore } from "../../core/adapters.js";
import { notTombstonedSql as session_activity_import_notTombstonedSql } from "../../db/session-read-model.js";
import { occurredAt as session_activity_import_occurredAt } from "../../db/session-dates.js";
import { keyset as session_activity_import_keyset } from "../scope.js";
import type { ReadScope as session_activity_import_ReadScope } from "../scope.js";
import { sessions_firstPromptSql, sessions_relatedSessionLabel } from './sessions.js';
import { lineage_CHILDREN_INDEX } from './lineage.js';

/** The columns every edge term selects: the edge, its order, and the related session `r` it names, which a left join leaves null. */
const session_activity_edgeColumns = (type: string, edge: string, related: string, at: string, reason: string): string =>
  `'${type}' AS type, '${edge}' AS edge, '${edge}:' || ${related} AS id, ${at} AS at, r.session_id AS related, r.title AS title,
    ${sessions_firstPromptSql('r')} AS first_prompt, r.agent AS agent, ${reason} AS reason`;

/**
 * Each edge source declares the sessions that stand in one parent relation to this one, each term binding the Project
 * and the session: a child it launched, at the child's start; a session that continues its conversation, at that
 * session's start; and the conversation it continues, at its own start.
 */
const session_activity_EDGE_SOURCES = [
  {
    type: 'child_session', terms: [
      `SELECT ${session_activity_edgeColumns('child_session', 'child', 'r.session_id', session_activity_import_occurredAt('r.'), 'NULL')}
      FROM sessions r INDEXED BY ${lineage_CHILDREN_INDEX.launched} WHERE r.project_id = ? AND r.launch_parent_session_id = ? AND ${session_activity_import_notTombstonedSql('r')}`,
    ]
  },
  {
    type: 'continuation', terms: [
      `SELECT ${session_activity_edgeColumns('continuation', 'continued_by', 'r.session_id', session_activity_import_occurredAt('r.'), 'r.parent_reason')}
      FROM sessions r INDEXED BY ${lineage_CHILDREN_INDEX.continuation} WHERE r.project_id = ? AND r.parent_session_id = ? AND ${session_activity_import_notTombstonedSql('r')}`,
      `SELECT ${session_activity_edgeColumns('continuation', 'continues', 's.parent_session_id', session_activity_import_occurredAt('s.'), 's.parent_reason')}
      FROM sessions s LEFT JOIN sessions r ON r.project_id = s.project_id AND r.session_id = s.parent_session_id AND ${session_activity_import_notTombstonedSql('r')}
      WHERE s.project_id = ? AND s.session_id = ? AND s.parent_session_id IS NOT NULL`,
    ]
  },
] as const;

type session_activity_EdgeKey = 'child' | 'continued_by' | 'continues';

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

const session_activity_EDGE_DETAILS: Readonly<Record<session_activity_EdgeKey, string>> = {
  child: 'Child of this session',
  continued_by: 'Continues this session’s conversation',
  continues: 'This session continues its conversation',
};

/** The title of a session row whose related session this Project does not hold. */
const session_activity_NOT_CAPTURED_TITLE = 'A session not captured here';

/** A session's parent edges of the named type, as activity rows, newest first after the cursor. */
const session_activity_sessionEdges = session_activity_sessionEdgesImpl;

async function session_activity_sessionEdgesImpl(db: session_activity_import_RelationalStore, scope: session_activity_import_ReadScope, sessionId: string, opts: session_activity_SessionActivityOptions = {}): Promise<session_activity_SessionActivityRow[]> {
  const sources = session_activity_EDGE_SOURCES.filter(source => opts.type === undefined || source.type === opts.type);
  return sources.length === 0 ? [] : session_activity_edgeRows(db, scope, sessionId, sources, opts);
}

/** One statement over every selected edge, ordered and paged as one list. */
async function session_activity_edgeRows(db: session_activity_import_RelationalStore, scope: session_activity_import_ReadScope, sessionId: string, sources: readonly typeof session_activity_EDGE_SOURCES[number][], opts: session_activity_SessionActivityOptions): Promise<session_activity_SessionActivityRow[]> {
  const paging = session_activity_import_keyset(opts, { order: 'e.at', id: 'e.id', direction: 'DESC' })!;
  const rows=await (async()=>{
  const terms = sources.flatMap(source => source.terms.map(sql=>sql));
  const { results } = await db.prepare(`SELECT e.type, e.edge, e.id, e.at, e.related, e.title, e.first_prompt, e.agent, e.reason
    FROM (${terms.join(' UNION ALL ')}) e ${paging.where ? `WHERE ${paging.where}` : ''}
    ORDER BY e.at DESC, e.id DESC LIMIT ?`).bind(...[...terms.flatMap(() => [scope.projectId,sessionId]),...paging.params,paging.limit+1])
    .all<{ type: session_activity_SessionActivityType; edge: session_activity_EdgeKey; id: string; at: number; related: string | null; title: string | null; first_prompt: string | null; agent: string | null; reason: string | null }>();
  return results;
  })();
  return rows.map((row): session_activity_SessionActivityRow => ({
    id: row.id, type: row.type, at: row.at,
    title: row.related === null ? session_activity_NOT_CAPTURED_TITLE : sessions_relatedSessionLabel(row.title, row.first_prompt, row.agent),
    detail: [session_activity_EDGE_DETAILS[row.edge], row.reason].filter(Boolean).join(' · '),
    sessionId: row.related, agent: row.agent,
  }));
}

export { type session_activity_SessionActivityType, type session_activity_SessionActivityRow, type session_activity_SessionActivityOptions, session_activity_sessionEdges };
