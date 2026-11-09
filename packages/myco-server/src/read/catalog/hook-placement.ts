import { placedPromptSql } from '../document-catalog.js';
import type { RelationalStore as hook_placement_import_RelationalStore } from "../../core/adapters.js";
import { subagentContextIdentities } from '../hook-placement.js';
import { binaryOrder as hook_placement_import_binaryOrder } from "../scope.js";
import { keyset as hook_placement_import_keyset } from "../scope.js";
import { page as hook_placement_import_page } from "../scope.js";
import type { ReadScope as hook_placement_import_ReadScope } from "../scope.js";
import { queryRows } from './shared.js';

interface hook_placement_HookHintSql { project: string; session: string; prompt: string }

/** A hint places a record only in its own Project and session's prompt set. */
function hook_placement_hookPlacementSql(hint: hook_placement_HookHintSql): string {
  return placedPromptSql(hint);
}

function hook_placement_placedHintSql(hint: hook_placement_HookHintSql): string {
  return `CASE WHEN ${hook_placement_hookPlacementSql(hint)} THEN ${hint.prompt} ELSE NULL END`;
}

const hook_placement_DELIVERY_RECORD_SOURCES = [
  { table: 'spore_injections', kind: 'receipt', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: 'delivered_at IS NOT NULL' },
  {
    table: 'prompt_context_answers', kind: 'answer', id: 'id', hint: 'r.delivered_prompt_id', label: "'Context received'", where: `outcome = 'served' AND delivered_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM spore_injections receipt WHERE receipt.project_id = r.project_id AND receipt.session_id = r.session_id AND receipt.id = r.receipt_id)`, unplacedPrompt:'r.prompt_id'
  },
] as const;

/** The placement hint for each hook record class. Selection remains diagnostic. */
const hook_placement_HOOK_RECORD_SOURCES = [
  ...hook_placement_DELIVERY_RECORD_SOURCES,
  { table: 'session_injections', kind: 'session_context', id: 'kind', hint: 'r.placement_hint', label: "CASE WHEN kind = 'plan-nudge' THEN 'Plan reminder' ELSE 'Context for a sub-agent' END", where: '1 = 1' },
  { table: 'attachments', kind: 'attachment', id: 'attachment_id', hint: 'r.prompt_id', label: "COALESCE(description, 'Attachment')", where: '1 = 1' },
  { table: 'events', index: 'idx_events_subagent_start', kind: 'event', id: 'event_id', hint: "json_extract(payload, '$.parentPromptId')", label: "'Sub-agent started'", where: "kind = 'subagent.start'" },
  { table: 'events', kind: 'event', id: 'event_id', hint: "CASE WHEN kind = 'turn' THEN json_extract(payload, '$.promptId') ELSE json_extract(payload, '$.parentPromptId') END", label: "CASE kind WHEN 'turn' THEN 'Turn ' || COALESCE(json_extract(payload, '$.phase'), '') ELSE 'Sub-agent stopped' END", where: "kind IN ('turn', 'subagent.stop')" },
] as const;

function hook_placement_unplacedSourceSql(source: typeof hook_placement_HOOK_RECORD_SOURCES[number], relation: string = source.table): string {
  const table = `${relation} r${'index' in source ? ` INDEXED BY ${source.index}` : ''}`;
  return `SELECT project_id, session_id, '${source.kind}:' || ${source.id} AS record_key,
    '${source.kind}' AS record_kind, ${source.id} AS record_id, ${source.hint} AS prompt_hint,
    ${source.label} AS label, created_at FROM ${table}
    WHERE ${source.where}${'unplacedPrompt' in source?'\n    AND NOT '+hook_placement_hookPlacementSql({project:'r.project_id',session:'r.session_id',prompt:source.unplacedPrompt}):''}
      AND NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: source.hint })}`;
}

/** Sub-agent context carries the canonical agent identity and its start event's parent hint. */
async function hook_placement_sessionContextHints(db: hook_placement_import_RelationalStore, scope?: hook_placement_import_ReadScope, sessionId?: string) {
  const conditions = ['r.project_id = pr.project_id'];
  const params: unknown[] = [];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  const records = { sql: `SELECT r.* FROM projects pr CROSS JOIN session_injections r WHERE ${conditions.join(' AND ')}`, params };
  const projected = await (async()=>{
  const { results } = await db.prepare(`SELECT r.project_id, r.session_id, r.kind, ${"NULL"} AS __myco_capture_context FROM (${records.sql}) r
    WHERE r.kind >= 'cortex:' AND r.kind < 'cortex;'`).bind(...records.params).all<{ project_id: string; session_id: string; kind: string }>();
  return results;
  })();
  const identities = await subagentContextIdentities(projected);
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

interface hook_placement_UnplacedHookRecord {
  key: string; kind: string; id: string; promptHint: string | null; label: string; createdAt: number;
}

const hook_placement_HOOK_STATUS_WINDOW_DAYS = 7;

const hook_placement_HOOK_STATUS_WINDOW_MS = hook_placement_HOOK_STATUS_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The status window counts delivered receipts and served answers, excluding tombstoned sessions. */
async function hook_placement_countUnplacedContextRecords(db: hook_placement_import_RelationalStore, scope?: hook_placement_import_ReadScope, sessionId?: string, now = Date.now()): Promise<number> {
  const from = now - hook_placement_HOOK_STATUS_WINDOW_MS;
  const conditions = ['r.project_id = s.project_id', 'r.created_at >= ?', 'NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = r.project_id AND t.session_id = r.session_id)'];
  const params: unknown[] = [from];
  if (scope !== undefined) { conditions.push('r.project_id = ?'); params.push(scope.projectId); }
  if (sessionId !== undefined) { conditions.push('r.session_id = ?'); params.push(sessionId); }
  let total=0;
  for(const source of hook_placement_DELIVERY_RECORD_SOURCES){
   total+=await (async()=>{
    const hint=hook_placement_hookPlacementSql({project:'r.project_id',session:'r.session_id',prompt:source.hint});
    const prompt='unplacedPrompt' in source?hook_placement_hookPlacementSql({project:'r.project_id',session:'r.session_id',prompt:source.unplacedPrompt}):null;
    const captures='NULL';
    const placed=hint;
    const promptPlaced=prompt!==null?', '+prompt+' AS __myco_delivery_prompt_placed':'';
    const sql=`SELECT COUNT(*) FILTER (WHERE NOT r.__myco_delivery_placed${prompt!==null?' AND NOT r.__myco_delivery_prompt_placed':''}) AS n,
      COUNT(*) AS total
      FROM projects s CROSS JOIN (SELECT project_id, session_id, '${source.kind}:' || ${source.id} AS record_key,
    '${source.kind}' AS record_kind, ${source.id} AS record_id, ${source.hint} AS prompt_hint,
    ${source.label} AS label, created_at, ${captures} AS __myco_delivery_capture, ${placed} AS __myco_delivery_placed${promptPlaced} FROM ${source.table} r
    WHERE ${source.where}) r
      WHERE ${conditions.join(' AND ')}`;
    const row=await db.prepare(sql).bind(...params)
      .first<{n:number;__myco_aggregate_sources:unknown}>();
    if(row===null)return 0;
    return row.n;
   })();
  }
  return total;
}

/** Unplaced records stay visible at session level, in immutable capture order. */
 const hook_placement_listUnplacedHookRecords = hook_placement_listUnplacedHookRecordsImpl;

async function hook_placement_listUnplacedHookRecordsImpl(db: hook_placement_import_RelationalStore, scope: hook_placement_import_ReadScope, sessionId: string, opts: { limit?: number; cursor?: string } = {}) {
  const k = hook_placement_import_keyset(opts, { order: 'created_at', id: 'record_key', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const contexts = await hook_placement_sessionContextHints(db, scope, sessionId);
  const sourceRows = (source: typeof hook_placement_HOOK_RECORD_SOURCES[number]) => queryRows<Record<string, unknown>>(db,`SELECT * FROM (${hook_placement_unplacedSourceSql(source, source.table === 'session_injections' ? `(${contexts.sql})` : source.table)})
    WHERE project_id = ? AND session_id = ? ${k.where === '' ? '' : `AND ${k.where}`}
    ORDER BY created_at, record_key LIMIT ?`,[...(source.table === 'session_injections' ? contexts.params : []), scope.projectId, sessionId, ...k.params, k.limit + 1],'all');
  const [first, ...remaining] = hook_placement_HOOK_RECORD_SOURCES;
  const captured = await sourceRows(first);
  const pages = [captured, ...await Promise.all(remaining.map(sourceRows))];
  const results = pages.flat().sort((a, b) => Number(a.created_at) - Number(b.created_at)
    || hook_placement_import_binaryOrder(String(a.record_key), String(b.record_key)));
  const rows: hook_placement_UnplacedHookRecord[] = results.map(row => ({ key: row.record_key as string, kind: row.record_kind as string,
    id: row.record_id as string, promptHint: row.prompt_hint as string | null, label: row.label as string, createdAt: row.created_at as number }));
  return hook_placement_import_page(rows, k.limit, row => ({ createdAt: row.createdAt, id: row.key }));
}

export {
  hook_placement_listUnplacedHookRecords,
  hook_placement_HOOK_STATUS_WINDOW_DAYS,
  hook_placement_countUnplacedContextRecords,
  hook_placement_placedHintSql,
  hook_placement_hookPlacementSql,
  hook_placement_sessionContextHints,
};
