import type { ToolResultReason } from '@goondocks/myco-shared/member-protocol';
import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** Each source declares its stored classification, immutable order and structured filters. */
export const SESSION_ACTIVITY_SOURCES = [
  { type: 'failure', where: "t.success = 0 AND (t.result_reason = 'reported' OR t.result_reason IS NULL)", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
  { type: 'no_result', where: "t.success = 0 AND t.result_reason IN ('no_result:complete_file', 'no_result:session_end', 'no_result:idle', 'pending_limit')", order: 't.created_at', id: 't.tool_call_id', tool: 't.tool_name', failed: 't.success = 0' },
] as const;

export type SessionActivityType = typeof SESSION_ACTIVITY_SOURCES[number]['type'];

export interface SessionActivityRow {
  id: string;
  type: SessionActivityType;
  title: string;
  detail: string;
  at: number;
  promptId: string | null;
  toolName: string;
  resultReason: ToolResultReason | null;
  failed: boolean;
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
  'no_result:complete_file': 'No result captured before the transcript completed',
  'no_result:session_end': 'No result captured before the session ended',
  'no_result:idle': 'No result captured before the session became idle',
  pending_limit: 'Pending tool call limit reached',
};

/** Stored tool outcomes only; tool bodies and provider errors never enter this projection. */
export async function listSessionActivity(db: RelationalStore, scope: ReadScope, sessionId: string, opts: SessionActivityOptions = {}): Promise<Page<SessionActivityRow> & { tools: string[] }> {
  const sources = SESSION_ACTIVITY_SOURCES.filter(source => opts.type === undefined || source.type === opts.type);
  const source = sources[0];
  const paging = keyset(opts, { order: source.order, id: source.id, direction: 'DESC' });
  if (paging === null) throw new Error('malformed cursor');
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
  const rows = results.map((row): SessionActivityRow => ({
    id: row.id, type: row.type, title: row.result_reason === null ? 'Tool call did not succeed' : row.tool_name,
    detail: [row.result_reason === null ? 'Reason not recorded' : REASON_DETAILS[row.result_reason], row.prompt_id === null ? 'Not tied to a prompt' : null].filter(Boolean).join(' · '),
    at: row.at, promptId: row.prompt_id, toolName: row.tool_name, resultReason: row.result_reason, failed: true,
  }));
  const tools = await db.prepare(`SELECT DISTINCT t.tool_name FROM tool_calls t WHERE t.project_id = ? AND t.session_id = ?
    AND (${SESSION_ACTIVITY_SOURCES.map(source => `(${source.where})`).join(' OR ')}) ORDER BY t.tool_name`)
    .bind(scope.projectId, sessionId).all<{ tool_name: string }>();
  return { ...page(rows, paging.limit, row => ({ createdAt: row.at, id: row.id })), tools: tools.results.map(row => row.tool_name) };
}
