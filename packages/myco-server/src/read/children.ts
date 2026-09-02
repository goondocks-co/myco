import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** A child projection read: its table, the columns to select, and the id column that breaks a tie on `created_at`. Ordered oldest-first — a session reads forward in time. */
export interface ChildQuery<T> {
  table: string;
  columns: string;
  idColumn: string;
  /** The column the table's session index orders by. `plans` carries BOTH `created_at` and `updated_at` and is indexed on the latter, so each table names its own. */
  orderColumn: string;
  map: (row: Record<string, unknown>) => T;
}

/** Paging plus, for the tables that carry one, the prompt whose children the page is narrowed to; `idx_tool_calls_prompt` and `idx_attachments_prompt` serve the narrowed order. */
export interface ChildOptions { limit?: number; cursor?: string; promptId?: string }

export async function listChildren<T>(
  db: RelationalStore,
  query: ChildQuery<T>,
  scope: ReadScope,
  sessionId: string,
  opts: ChildOptions = {}
): Promise<Page<T & { orderedAt: number }>> {
  const order = query.orderColumn;
  const k = keyset(opts, { order, id: query.idColumn, direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const limit = k.limit;
  const conditions = ['project_id = ?', 'session_id = ?'];
  const params: unknown[] = [scope.projectId, sessionId];
  if (opts.promptId !== undefined) { conditions.push('prompt_id = ?'); params.push(opts.promptId); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const sql = `SELECT ${query.columns}, ${order} AS order_at, ${query.idColumn} FROM ${query.table}
                WHERE ${conditions.join(' AND ')}
                ORDER BY ${order} ASC, ${query.idColumn} ASC LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...params, limit + 1).all<Record<string, unknown>>();
  const rows = results.map((row) => ({ ...query.map(row), orderedAt: row.order_at as number, __id: row[query.idColumn] as string }));
  const paged = page(rows, limit, (r) => ({ createdAt: r.orderedAt, id: r.__id }));
  return { rows: paged.rows.map(({ __id, ...rest }) => rest as T & { orderedAt: number }), cursor: paged.cursor };
}

export interface PromptRow { promptId: string; text: string | null; blobKey: string | null; origin: string; promptKind: string | null; parentPromptId: string | null; threadLabel: string | null; createdAt: number; orderedAt: number }
/** A tool call and how it went. `inputPreview` is the first `INPUT_PREVIEW_CHARS` of the input and `inputBytes` its full length: an input can be a whole file, and a page of them is not. */
export interface ToolCallRow {
  toolCallId: string; promptId: string | null; toolName: string; mycoTool: string | null; mycoOp: string | null;
  inputPreview: string | null; inputBytes: number | null; inputBlobKey: string | null; outputPreview: string | null; outputBlobKey: string | null;
  success: boolean; errorMessage: string | null; durationMs: number | null; filesAffected: string | null; createdAt: number; orderedAt: number;
}
export const INPUT_PREVIEW_CHARS = 2048;
export interface ResponseRow { responseId: string; promptId: string | null; text: string | null; blobKey: string | null; createdAt: number; orderedAt: number }
/** `planKey` is the plan's identity in this table (its primary key), not a session-scoped id. `createdAt` is the plan's first capture; `orderedAt` carries the `updated_at` this listing pages over. */
export interface PlanRow { planKey: string; title: string | null; status: string; content: string | null; blobKey: string | null; createdAt: number; updatedAt: number; orderedAt: number }
/** `promptId` names the prompt an attachment accompanies, when the capture named one; the session page shows the image under that prompt. */
export interface AttachmentRow { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number; orderedAt: number }

export const PROMPT_QUERY: ChildQuery<Omit<PromptRow, 'orderedAt'>> = {
  table: 'prompt_batches', columns: 'prompt_id, text, blob_key, origin, prompt_kind, parent_prompt_id, thread_label, created_at', idColumn: 'prompt_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number, promptId: r.prompt_id as string, text: (r.text as string | null) ?? null, blobKey: (r.blob_key as string | null) ?? null, origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null, parentPromptId: (r.parent_prompt_id as string | null) ?? null, threadLabel: (r.thread_label as string | null) ?? null,
  }),
};

export const TOOL_CALL_QUERY: ChildQuery<Omit<ToolCallRow, 'orderedAt'>> = {
  table: 'tool_calls',
  columns: `tool_call_id, prompt_id, tool_name, myco_tool, myco_op, substr(input, 1, ${INPUT_PREVIEW_CHARS}) AS input_preview, length(input) AS input_bytes,
    input_blob_key, output_preview, output_blob_key, success, error_message, duration_ms, files_affected, created_at`,
  idColumn: 'tool_call_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number, toolCallId: r.tool_call_id as string, promptId: (r.prompt_id as string | null) ?? null, toolName: r.tool_name as string,
    mycoTool: (r.myco_tool as string | null) ?? null, mycoOp: (r.myco_op as string | null) ?? null,
    inputPreview: (r.input_preview as string | null) ?? null, inputBytes: (r.input_bytes as number | null) ?? null, inputBlobKey: (r.input_blob_key as string | null) ?? null,
    outputPreview: (r.output_preview as string | null) ?? null, outputBlobKey: (r.output_blob_key as string | null) ?? null,
    success: Number(r.success) === 1, errorMessage: (r.error_message as string | null) ?? null, durationMs: (r.duration_ms as number | null) ?? null,
    filesAffected: (r.files_affected as string | null) ?? null,
  }),
};

export const RESPONSE_QUERY: ChildQuery<Omit<ResponseRow, 'orderedAt'>> = {
  table: 'responses', columns: 'response_id, prompt_id, text, blob_key, created_at', idColumn: 'response_id', orderColumn: 'created_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    responseId: r.response_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
  }),
};

/** Plans order by `updated_at` — the column `idx_plans_session` indexes — and are keyed by `plan_key`. */
export const PLAN_QUERY: ChildQuery<Omit<PlanRow, 'orderedAt'>> = {
  table: 'plans', columns: 'plan_key, title, status, content, blob_key, created_at, updated_at', idColumn: 'plan_key', orderColumn: 'updated_at',
  map: (r) => ({
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    planKey: r.plan_key as string,
    title: (r.title as string | null) ?? null,
    status: r.status as string,
    content: (r.content as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
  }),
};

export const ATTACHMENT_QUERY: ChildQuery<Omit<AttachmentRow, 'orderedAt'>> = {
  table: 'attachments', columns: 'attachment_id, prompt_id, blob_key, media_type, byte_size, description, created_at', idColumn: 'attachment_id', orderColumn: 'created_at',
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

export const listPrompts = (db: RelationalStore, scope: ReadScope, sessionId: string, opts?: ChildOptions) => listChildren(db, PROMPT_QUERY, scope, sessionId, opts);
export const listToolCalls = (db: RelationalStore, scope: ReadScope, sessionId: string, opts?: ChildOptions) => listChildren(db, TOOL_CALL_QUERY, scope, sessionId, opts);
export const listResponses = (db: RelationalStore, scope: ReadScope, sessionId: string, opts?: ChildOptions) => listChildren(db, RESPONSE_QUERY, scope, sessionId, opts);
export const listPlans = (db: RelationalStore, scope: ReadScope, sessionId: string, opts?: ChildOptions) => listChildren(db, PLAN_QUERY, scope, sessionId, opts);
export const listAttachments = (db: RelationalStore, scope: ReadScope, sessionId: string, opts?: ChildOptions) => listChildren(db, ATTACHMENT_QUERY, scope, sessionId, opts);

export interface MaterialRow { prompt: string; response: string | null }

/** A session's earliest inline user prompts, each cut to `excerptChars`, with the start of its first inline response; `limit` prompts at most, oldest first. */
export async function sessionMaterialRows(db: RelationalStore, projectId: string, sessionId: string, opts: { limit: number; excerptChars: number }): Promise<MaterialRow[]> {
  const { results } = await db
    .prepare(`SELECT substr(pb.text, 1, ?) AS prompt,
                     (SELECT substr(r.text, 1, ?) FROM responses r
                       WHERE r.project_id = pb.project_id AND r.session_id = pb.session_id AND r.prompt_id = pb.prompt_id AND r.text IS NOT NULL
                       ORDER BY r.created_at, r.response_id LIMIT 1) AS response
                FROM prompt_batches pb
               WHERE pb.project_id = ? AND pb.session_id = ? AND pb.origin = 'user' AND pb.text IS NOT NULL
               ORDER BY pb.created_at, pb.prompt_id LIMIT ?`)
    .bind(opts.excerptChars, opts.excerptChars, projectId, sessionId, opts.limit)
    .all<{ prompt: string; response: string | null }>();
  return results.map((r) => ({ prompt: r.prompt, response: r.response ?? null }));
}
