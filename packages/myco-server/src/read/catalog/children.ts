import type { RelationalStore as children_import_RelationalStore } from "../../core/adapters.js";
import { keyset as children_import_keyset } from "../scope.js";
import { page as children_import_page } from "../scope.js";
import type { Page as children_import_Page } from "../scope.js";
import type { ReadScope as children_import_ReadScope } from "../scope.js";
import { hook_placement_hookPlacementSql, hook_placement_placedHintSql } from './hook-placement.js';
import { plans_progressOf } from './plans.js';
import { queryRows } from './shared.js';

/** A child projection read: its table, selected columns, order expression and tie-breaking identity. */
interface children_ChildQuery<T> {
  table: string;
  index?: string;
  promptHint?: string;
  columns: string;
  idColumn: string;
  /** The numeric ordering expression paired with the identity in a page cursor. */
  orderColumn: string;
  map: (row: Record<string, unknown>) => T;
}

/** Paging plus, for the tables that carry one, the prompt whose children the page is narrowed to; `idx_tool_calls_prompt` and `idx_attachments_prompt` serve the narrowed order. */
interface children_ChildOptions { limit?: number; cursor?: string; promptId?: string }

/** Conditions a child read adds past the session scope, each a SQL term with the values it binds. */
interface children_ChildFilter { sql: string; params: readonly unknown[] }

function children_childColumns<T>(query: children_ChildQuery<T>): string {
  if (query.promptHint === undefined) return query.columns;
  return `${hook_placement_placedHintSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` })} AS prompt_id, ${query.columns}`;
}

/** `planKey` is the plan's identity in this table (its primary key), not a session-scoped id. `createdAt` is the plan's first capture; `orderedAt` carries the `updated_at` this listing pages over. */
interface children_PlanRow { planKey: string; promptId: string | null; title: string | null; status: string; content: string | null; blobKey: string | null; originPath: string | null; progress: string; updatedBy: string | null; createdAt: number; updatedAt: number; orderedAt: number }

/** `promptId` names the session prompt the attachment's captured hint resolves to; an unplaced attachment carries null. */
interface children_AttachmentRow { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number; orderedAt: number }

/**
 * A record of what Myco served the session as a whole: a session-level block (`kind` names it: `cortex` for the start,
 * `cortex:<agent>` for a sub-agent's, `plan-nudge`), or context no named prompt received (`kind` is `context:<row
 * id>`): an answer, or a receipt no answer names, which outlives the answers' retention. `delivery` says whether it
 * reached the agent with no matching prompt in this session, or has no reported delivery.
 */
interface children_ContextInjectionRow { kind: string; createdAt: number; orderedAt: number; delivery: 'unnamed_prompt' | 'not_delivered' | null }

/** The prefix of an answer row's `kind` in the session's context records. */
const children_SESSION_ANSWER_KIND_PREFIX = 'context:';

const children_CONTEXT_INJECTION_QUERY: children_ChildQuery<Omit<children_ContextInjectionRow, 'orderedAt'>> = {
  table: `(SELECT project_id, session_id, kind, created_at, NULL AS delivery FROM session_injections
     UNION ALL
     SELECT project_id, session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || id AS kind, created_at,
       CASE WHEN delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM prompt_context_answers WHERE outcome = 'served' AND NOT ${hook_placement_hookPlacementSql({ project: 'prompt_context_answers.project_id', session: 'prompt_context_answers.session_id', prompt: 'prompt_context_answers.delivered_prompt_id' })}
     UNION ALL
     SELECT r.project_id, r.session_id, '${children_SESSION_ANSWER_KIND_PREFIX}' || r.id AS kind, r.created_at,
       CASE WHEN r.delivered_at IS NULL THEN 'not_delivered' ELSE 'unnamed_prompt' END AS delivery
       FROM spore_injections r WHERE NOT ${hook_placement_hookPlacementSql({ project: 'r.project_id', session: 'r.session_id', prompt: 'r.delivered_prompt_id' })}
         AND NOT EXISTS (SELECT 1 FROM prompt_context_answers a
                          WHERE a.project_id = r.project_id AND a.session_id = r.session_id AND a.receipt_id = r.id))`,
  columns: 'kind, created_at, delivery', idColumn: 'kind', orderColumn: 'created_at',
  map: (r) => ({ kind: r.kind as string, createdAt: r.created_at as number, delivery: (r.delivery as children_ContextInjectionRow['delivery']) ?? null }),
};

/** Plans order by `updated_at` — the column `idx_plans_session` indexes — and are keyed by `plan_key`. */
const children_PLAN_QUERY: children_ChildQuery<Omit<children_PlanRow, 'orderedAt'>> = {
  table: 'plans', index: 'idx_plans_session', columns: 'plan_key, prompt_id, title, status, content, blob_key, origin_path, updated_by, created_at, updated_at', idColumn: 'plan_key', orderColumn: 'updated_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    planKey: r.plan_key as string,
    promptId: (r.prompt_id as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    status: r.status as string,
    content: (r.content as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    originPath: (r.origin_path as string | null) ?? null,
    progress: plans_progressOf((r.content as string | null) ?? null),
    updatedBy: (r.updated_by as string | null) ?? null,
  }),
};

const children_ATTACHMENT_QUERY: children_ChildQuery<Omit<children_AttachmentRow, 'orderedAt'>> = {
  table: 'attachments', promptHint: 'prompt_id', columns: 'attachment_id, blob_key, media_type, byte_size, description, created_at', idColumn: 'attachment_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    attachmentId: r.attachment_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    blobKey: r.blob_key as string,
    mediaType: r.media_type as string,
    byteSize: r.byte_size as number,
    description: (r.description as string | null) ?? null,
  }),
};

/** Paging alone, for a table with no prompt column to narrow by. */
type children_PagingOptions = Pick<children_ChildOptions, 'limit' | 'cursor'>;

const children_listContextInjections = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_PagingOptions) => children_listChildren(db, children_CONTEXT_INJECTION_QUERY, scope, sessionId, opts);

/** A session's plans narrowed to one status; the term leaves `idx_plans_session` serving the scope and the order. */
interface children_PlanChildOptions extends children_ChildOptions { status?: string }

function children_listPlans(db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts: children_PlanChildOptions = {}) {
  const { status, ...paging } = opts;
  const filters: children_ChildFilter[] = [];
  if (status !== undefined) filters.push({ sql: 'status = ?', params: [status] });
  return children_listChildren(db, children_PLAN_QUERY, scope, sessionId, paging, filters);
}

const children_listAttachments = (db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts?: children_ChildOptions) => children_listChildren(db, children_ATTACHMENT_QUERY, scope, sessionId, opts);

 async function children_listChildren<T>(
  db: children_import_RelationalStore,
  query: children_ChildQuery<T>,
  scope: children_import_ReadScope,
  sessionId: string,
  opts: children_ChildOptions = {},
  filters: readonly children_ChildFilter[] = []
): Promise<children_import_Page<T & { orderedAt: number }>> {
  const order = query.orderColumn;
  const k = children_import_keyset(opts, { order, id: query.idColumn, direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const limit = k.limit;
  const conditions = ['project_id = ?', 'session_id = ?'];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.promptId !== undefined) {
    conditions.push(`${query.promptHint ?? 'prompt_id'} = ?`); params.push(opts.promptId);
    if (query.promptHint !== undefined) conditions.push(hook_placement_hookPlacementSql({ project: `${query.table}.project_id`, session: `${query.table}.session_id`, prompt: `${query.table}.${query.promptHint}` }));
  }
  for (const filter of filters) { conditions.push(filter.sql); params.push(...filter.params); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const sql = `SELECT ${children_childColumns(query)}, ${order} AS order_at, ${query.idColumn} FROM ${query.table}${query.index === undefined ? '' : ` INDEXED BY ${query.index}`}
                WHERE ${conditions.join(' AND ')}
                ORDER BY ${order} ASC, ${query.idColumn} ASC LIMIT ?`;
  const { results } = await ({ results: await queryRows<Record<string, unknown>>(db,sql,[...params, limit + 1],'all') });
  const rows = results.map((row) => ({ ...query.map(row), orderedAt: row.order_at as number, __id: row[query.idColumn] as string }));
  const paged = children_import_page(rows, limit, (r) => ({ createdAt: r.orderedAt, id: r.__id }));
  return { rows: paged.rows.map(({ __id, ...rest }) => rest as T & { orderedAt: number }), cursor: paged.cursor };
}

export { children_listContextInjections, children_listPlans, children_listAttachments };
