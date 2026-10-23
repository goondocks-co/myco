import type { RelationalStore } from '../core/adapters.js';
import { uuidv5 } from '../hash.js';
import { binaryOrder, keyset, page, type ReadScope } from './scope.js';

export interface HookHintSql { project: string; session: string; prompt: string }

/** A hint places a record only in its own Project and session's prompt set. */
export function hookPlacementSql(hint: HookHintSql): string {
  return `EXISTS (SELECT 1 FROM prompt_batches hook_prompt WHERE hook_prompt.project_id = ${hint.project}
    AND hook_prompt.session_id = ${hint.session} AND hook_prompt.prompt_id = ${hint.prompt})`;
}

export function placedHintSql(hint: HookHintSql): string {
  return `CASE WHEN ${hookPlacementSql(hint)} THEN ${hint.prompt} ELSE NULL END`;
}

const DELIVERY_RECORD_SOURCES = [
  { table: 'spore_injections', kind: 'receipt', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: 'delivered_at IS NOT NULL' },
  { table: 'prompt_context_answers', kind: 'answer', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: `outcome = 'served' AND delivered_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM spore_injections receipt WHERE receipt.project_id = r.project_id AND receipt.session_id = r.session_id AND receipt.id = r.receipt_id)
    AND NOT ${hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.prompt_id' })}` },
] as const;

/** The placement hint for each hook record class. Selection remains diagnostic. */
export const HOOK_RECORD_SOURCES = [
  ...DELIVERY_RECORD_SOURCES,
  { table: 'session_injections', kind: 'session_context', id: 'kind', hint: 'r.placement_hint', label: "CASE WHEN kind = 'plan-nudge' THEN 'Plan reminder' ELSE 'Context for a sub-agent' END", where: '1 = 1' },
  { table: 'tool_calls', kind: 'tool_call', id: 'tool_call_id', hint: 'r.prompt_id', label: 'tool_name', where: '1 = 1' },
  { table: 'attachments', kind: 'attachment', id: 'attachment_id', hint: 'r.prompt_id', label: "COALESCE(description, 'Attachment')", where: '1 = 1' },
  { table: 'events', index: 'idx_events_subagent_start', kind: 'event', id: 'event_id', hint: "json_extract(payload, '$.parentPromptId')", label: "'Sub-agent started'", where: "kind = 'subagent.start'" },
  { table: 'events', kind: 'event', id: 'event_id', hint: "CASE WHEN kind = 'turn' THEN json_extract(payload, '$.promptId') ELSE json_extract(payload, '$.parentPromptId') END", label: "CASE kind WHEN 'turn' THEN 'Turn ' || COALESCE(json_extract(payload, '$.phase'), '') ELSE 'Sub-agent stopped' END", where: "kind IN ('turn', 'subagent.stop')" },
] as const;

function unplacedSourceSql(source: typeof HOOK_RECORD_SOURCES[number], relation: string = source.table): string {
  const table = `${relation} r${'index' in source ? ` INDEXED BY ${source.index}` : ''}`;
  return `SELECT project_id, session_id, '${source.kind}:' || ${source.id} AS record_key,
    '${source.kind}' AS record_kind, ${source.id} AS record_id, ${source.hint} AS prompt_hint,
    ${source.label} AS label, created_at FROM ${table}
    WHERE ${source.where}
      AND NOT ${hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: source.hint })}`;
}

/** Sub-agent context carries the canonical agent identity and its start event's parent hint. */
export async function sessionContextHints(db: RelationalStore, scope?: ReadScope, sessionId?: string) {
  const conditions = ['r.project_id = pr.project_id'];
  const params: unknown[] = [];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  const records = { sql: `SELECT r.* FROM projects pr CROSS JOIN session_injections r WHERE ${conditions.join(' AND ')}`, params };
  const { results } = await db.prepare(`SELECT r.project_id, r.session_id, r.kind FROM (${records.sql}) r
    WHERE r.kind >= 'cortex:' AND r.kind < 'cortex;'`).bind(...records.params).all<{ project_id: string; session_id: string; kind: string }>();
  const identities = await Promise.all(results.map(async row => ({ ...row, subagent_id: await uuidv5('subagent', row.session_id, row.kind.slice('cortex:'.length)) })));
  return {
    sql: `SELECT si.*, (SELECT MAX(json_extract(e.payload, '$.parentPromptId')) FROM events e INDEXED BY idx_events_subagent_start
      WHERE e.project_id = si.project_id AND e.session_id = si.session_id AND e.kind = 'subagent.start'
        AND json_extract(e.payload, '$.subagentId') = json_extract(agent.value, '$.subagent_id')
      HAVING COUNT(DISTINCT json_extract(e.payload, '$.parentPromptId')) = 1
        AND COUNT(*) = COUNT(json_extract(e.payload, '$.parentPromptId'))) AS placement_hint
      FROM json_each(?) agent CROSS JOIN session_injections si
      WHERE si.project_id = json_extract(agent.value, '$.project_id') AND si.session_id = json_extract(agent.value, '$.session_id')
        AND si.kind = json_extract(agent.value, '$.kind')
      UNION ALL SELECT si.*, si.delivered_prompt_id AS placement_hint FROM (${records.sql}) si
      WHERE si.kind = 'plan-nudge' AND si.delivered_at IS NOT NULL`,
    params: [JSON.stringify(identities), ...records.params],
  };
}

export interface UnplacedHookRecord {
  key: string; kind: string; id: string; promptHint: string | null; label: string; createdAt: number;
}

/** Unplaced records stay visible at session level, in immutable capture order. */
export async function listUnplacedHookRecords(db: RelationalStore, scope: ReadScope, sessionId: string, opts: { limit?: number; cursor?: string } = {}) {
  const k = keyset(opts, { order: 'created_at', id: 'record_key', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const contexts = await sessionContextHints(db, scope, sessionId);
  const pages = await Promise.all(HOOK_RECORD_SOURCES.map(source => db.prepare(`SELECT * FROM (${unplacedSourceSql(source, source.table === 'session_injections' ? `(${contexts.sql})` : source.table)})
    WHERE project_id = ? AND session_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
    ORDER BY created_at, record_key LIMIT ?`).bind(...(source.table === 'session_injections' ? contexts.params : []), scope.projectId, sessionId, ...k.params, k.limit + 1).all<Record<string, unknown>>()));
  const results = pages.flatMap(result => result.results).sort((a, b) => Number(a.created_at) - Number(b.created_at)
    || binaryOrder(String(a.record_key), String(b.record_key)));
  const rows: UnplacedHookRecord[] = results.map(row => ({ key: row.record_key as string, kind: row.record_kind as string,
    id: row.record_id as string, promptHint: row.prompt_hint as string | null, label: row.label as string, createdAt: row.created_at as number }));
  return page(rows, k.limit, row => ({ createdAt: row.createdAt, id: row.key }));
}

export const HOOK_STATUS_WINDOW_DAYS = 7;
const HOOK_STATUS_WINDOW_MS = HOOK_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The status window counts delivered receipts and served answers, excluding tombstoned sessions. */
export async function countUnplacedContextRecords(db: RelationalStore, scope?: ReadScope, sessionId?: string, now = Date.now()): Promise<number> {
  const from = now - HOOK_STATUS_WINDOW_MS;
  const conditions = ['r.project_id = s.project_id', 'r.created_at >= ?', 'NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = r.project_id AND t.session_id = r.session_id)'];
  const params: unknown[] = [from];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  const counts = await Promise.all(DELIVERY_RECORD_SOURCES.map(source => {
    return db.prepare(`SELECT COUNT(*) AS n FROM projects s CROSS JOIN (${unplacedSourceSql(source)}) r
      WHERE ${conditions.join(' AND ')}`)
      .bind(...params).first<{ n: number }>();
  }));
  return counts.reduce((sum, row) => sum + (row?.n ?? 0), 0);
}
