import type { ToolResultReason } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from '../core/adapters.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { occurredAt } from '../db/session-dates.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';
import { CHILDREN_INDEX } from './lineage.js';
import { firstPromptSql, relatedSessionLabel } from './sessions.js';

/** Each tool source declares its stored classification, immutable order and structured filters. */
const TOOL_SOURCES = [
  { type: 'failure', where: "t.success = 0 AND (t.result_reason = 'reported' OR t.result_reason IS NULL)", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
  { type: 'no_result', where: "t.success = 0 AND t.result_reason IN ('no_result', 'pending_limit')", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
] as const;

/** The columns every edge term selects: the edge, its order, and the related session `r` it names, which a left join leaves null. */
const edgeColumns = (type: string, edge: string, related: string, at: string, reason: string): string =>
  `'${type}' AS type, '${edge}' AS edge, '${edge}:' || ${related} AS id, ${at} AS at, r.session_id AS related, r.title AS title,
    ${firstPromptSql('r')} AS first_prompt, r.agent AS agent, ${reason} AS reason`;

/**
 * Each edge source declares the sessions that stand in one parent relation to this one, each term binding the Project
 * and the session: a child it launched, at the child's start; a session that continues its conversation, at that
 * session's start; and the conversation it continues, at its own start.
 */
const EDGE_SOURCES = [
  { type: 'child_session', terms: [
    `SELECT ${edgeColumns('child_session', 'child', 'r.session_id', occurredAt('r.'), 'NULL')}
      FROM sessions r INDEXED BY ${CHILDREN_INDEX.launched} WHERE r.project_id = ? AND r.launch_parent_session_id = ? AND ${notTombstonedSql('r')}`,
  ] },
  { type: 'continuation', terms: [
    `SELECT ${edgeColumns('continuation', 'continued_by', 'r.session_id', occurredAt('r.'), 'r.parent_reason')}
      FROM sessions r INDEXED BY ${CHILDREN_INDEX.continuation} WHERE r.project_id = ? AND r.parent_session_id = ? AND ${notTombstonedSql('r')}`,
    `SELECT ${edgeColumns('continuation', 'continues', 's.parent_session_id', occurredAt('s.'), 's.parent_reason')}
      FROM sessions s LEFT JOIN sessions r ON r.project_id = s.project_id AND r.session_id = s.parent_session_id AND ${notTombstonedSql('r')}
      WHERE s.project_id = ? AND s.session_id = ? AND s.parent_session_id IS NOT NULL`,
  ] },
] as const;

type EdgeKey = 'child' | 'continued_by' | 'continues';

export const SESSION_ACTIVITY_SOURCES = [...TOOL_SOURCES, ...EDGE_SOURCES] as const;

export type SessionActivityType = typeof SESSION_ACTIVITY_SOURCES[number]['type'];

export interface SessionActivityRow {
  id: string;
  type: SessionActivityType;
  title: string;
  detail: string;
  at: number;
  promptId: string | null;
  /** The tool a tool row records; null on a session row. */
  toolName: string | null;
  resultReason: ToolResultReason | null;
  failed: boolean;
  /** The related session a session row opens; null on a tool row and for a session this Project does not hold. */
  sessionId: string | null;
  /** The related session's agent; null on a tool row. */
  agent: string | null;
}

export interface SessionActivityOptions {
  type?: SessionActivityType;
  tool?: string;
  failed?: boolean;
  limit?: number;
  cursor?: string;
}

const REASON_DETAILS: Readonly<Record<ToolResultReason, string>> = {
  reported: 'Tool reported a failure',
  no_result: 'No result captured',
  pending_limit: 'Pending tool call limit reached',
};

const EDGE_DETAILS: Readonly<Record<EdgeKey, string>> = {
  child: 'Child of this session',
  continued_by: 'Continues this session’s conversation',
  continues: 'This session continues its conversation',
};

/** The title of a session row whose related session this Project does not hold. */
export const NOT_CAPTURED_TITLE = 'A session not captured here';

/** SQLite's `BINARY` order over UTF-8 bytes, which the keyset compares ids by. */
function binaryOrder(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Stored tool outcomes and parent edges only; tool bodies and provider errors never enter this projection. */
export async function listSessionActivity(db: RelationalStore, scope: ReadScope, sessionId: string, opts: SessionActivityOptions = {}): Promise<Page<SessionActivityRow> & { tools: string[] }> {
  const named = (source: { type: string }) => opts.type === undefined || source.type === opts.type;
  const toolSources = TOOL_SOURCES.filter(named);
  const edgeSources = opts.tool !== undefined || opts.failed === true ? [] : EDGE_SOURCES.filter(named);
  const limit = keyset(opts, { order: 'at', id: 'id', direction: 'DESC' })?.limit;
  if (limit === undefined) throw new Error('malformed cursor');
  const rows = [
    ...toolSources.length === 0 ? [] : await toolRows(db, scope, sessionId, toolSources, opts),
    ...edgeSources.length === 0 ? [] : await edgeRows(db, scope, sessionId, edgeSources, opts),
  ].sort((a, b) => b.at - a.at || binaryOrder(b.id, a.id)).slice(0, limit + 1);
  const tools = await db.prepare(`SELECT DISTINCT t.tool_name FROM tool_calls t WHERE t.project_id = ? AND t.session_id = ?
    AND (${TOOL_SOURCES.map(source => `(${source.where})`).join(' OR ')}) ORDER BY t.tool_name`)
    .bind(scope.projectId, sessionId).all<{ tool_name: string }>();
  return { ...page(rows, limit, row => ({ createdAt: row.at, id: row.id })), tools: tools.results.map(row => row.tool_name) };
}

async function toolRows(db: RelationalStore, scope: ReadScope, sessionId: string, sources: readonly typeof TOOL_SOURCES[number][], opts: SessionActivityOptions): Promise<SessionActivityRow[]> {
  const source = sources[0]!;
  const paging = keyset(opts, { order: source.order, id: source.id, direction: 'DESC' })!;
  const filters = [`(${sources.map(source => `(${source.where})`).join(' OR ')})`];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.tool !== undefined) { filters.push(`${source.tool} = ?`); params.push(opts.tool); }
  if (opts.failed !== undefined) filters.push(opts.failed ? source.failed : `NOT (${source.failed})`);
  if (paging.where) { filters.push(paging.where); params.push(...paging.params); }
  const { results } = await db.prepare(`SELECT CASE ${sources.map(source => `WHEN ${source.where} THEN '${source.type}'`).join(' ')} END AS type,
      t.tool_call_id AS id, t.tool_name AS tool_name, t.result_reason AS result_reason, t.created_at AS at,
      CASE WHEN EXISTS (SELECT 1 FROM prompt_batches p WHERE p.project_id = t.project_id
        AND p.session_id = t.session_id AND p.prompt_id = t.prompt_id) THEN t.prompt_id ELSE NULL END AS prompt_id
    FROM tool_calls t WHERE t.project_id = ? AND t.session_id = ? AND ${filters.join(' AND ')}
    ORDER BY ${source.order} DESC, ${source.id} DESC LIMIT ?`)
    .bind(...params, paging.limit + 1).all<{ type: SessionActivityType; id: string; tool_name: string; result_reason: ToolResultReason | null; at: number; prompt_id: string | null }>();
  return results.map((row): SessionActivityRow => ({
    id: row.id, type: row.type, title: row.result_reason === null ? 'Tool call did not succeed' : row.tool_name,
    detail: [row.result_reason === null ? 'Reason not recorded' : REASON_DETAILS[row.result_reason], row.prompt_id === null ? 'Not tied to a prompt' : null].filter(Boolean).join(' · '),
    at: row.at, promptId: row.prompt_id, toolName: row.tool_name, resultReason: row.result_reason, failed: true, sessionId: null, agent: null,
  }));
}

/** One statement over every selected edge, ordered and paged as one list. */
async function edgeRows(db: RelationalStore, scope: ReadScope, sessionId: string, sources: readonly typeof EDGE_SOURCES[number][], opts: SessionActivityOptions): Promise<SessionActivityRow[]> {
  const paging = keyset(opts, { order: 'e.at', id: 'e.id', direction: 'DESC' })!;
  const terms = sources.flatMap(source => source.terms);
  const { results } = await db.prepare(`SELECT e.type, e.edge, e.id, e.at, e.related, e.title, e.first_prompt, e.agent, e.reason
    FROM (${terms.join(' UNION ALL ')}) e ${paging.where ? `WHERE ${paging.where}` : ''}
    ORDER BY e.at DESC, e.id DESC LIMIT ?`)
    .bind(...terms.flatMap(() => [scope.projectId, sessionId]), ...paging.params, paging.limit + 1)
    .all<{ type: SessionActivityType; edge: EdgeKey; id: string; at: number; related: string | null; title: string | null; first_prompt: string | null; agent: string | null; reason: string | null }>();
  return results.map((row): SessionActivityRow => ({
    id: row.id, type: row.type, at: row.at,
    title: row.related === null ? NOT_CAPTURED_TITLE : relatedSessionLabel(row.title, row.first_prompt, row.agent),
    detail: [EDGE_DETAILS[row.edge], row.reason].filter(Boolean).join(' · '),
    promptId: null, toolName: null, resultReason: null, failed: false, sessionId: row.related, agent: row.agent,
  }));
}
