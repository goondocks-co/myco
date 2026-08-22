import type { D1Like } from '../env.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from './scope.js';

/** A child projection read: its table, the columns to select, and the id column that breaks a tie on `created_at`. Ordered oldest-first — a session reads forward in time. */
interface ChildQuery<T> {
  table: string;
  columns: string;
  idColumn: string;
  /** The column the table's session index orders by. `plans` carries BOTH `created_at` and `updated_at` and is indexed on the latter, so each table names its own. */
  orderColumn: string;
  map: (row: Record<string, unknown>) => T;
}

async function listChildren<T>(
  db: D1Like,
  query: ChildQuery<T>,
  scope: ReadScope,
  sessionId: string,
  opts: { limit?: number; cursor?: string } = {}
): Promise<Page<T & { createdAt: number }>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const order = query.orderColumn;
  const where = after
    ? `AND (${order} > ? OR (${order} = ? AND ${query.idColumn} > ?))`
    : '';
  const sql = `SELECT ${query.columns}, ${order} AS order_at, ${query.idColumn} FROM ${query.table}
                WHERE project_id = ? AND session_id = ? ${where}
                ORDER BY ${order} ASC, ${query.idColumn} ASC LIMIT ?`;
  const statement = after
    ? db.prepare(sql).bind(scope.projectId, sessionId, after.createdAt, after.createdAt, after.id, limit + 1)
    : db.prepare(sql).bind(scope.projectId, sessionId, limit + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows = results.map((row) => ({ ...query.map(row), createdAt: row.order_at as number, __id: row[query.idColumn] as string }));
  const paged = page(rows, limit, (r) => ({ createdAt: r.createdAt, id: r.__id }));
  return { rows: paged.rows.map(({ __id, ...rest }) => rest as T & { createdAt: number }), cursor: paged.cursor };
}

export interface PromptRow { promptId: string; text: string | null; blobKey: string | null; origin: string; createdAt: number }
export interface ToolCallRow { toolCallId: string; toolName: string; createdAt: number }
export interface ResponseRow { responseId: string; promptId: string | null; text: string | null; blobKey: string | null; createdAt: number }
/** `planKey` is the plan's identity in this table (its primary key), not a session-scoped id. */
export interface PlanRow { planKey: string; title: string | null; status: string; blobKey: string | null; createdAt: number }
export interface AttachmentRow { attachmentId: string; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number }

export const listPrompts = (db: D1Like, scope: ReadScope, sessionId: string, opts?: { limit?: number; cursor?: string }) =>
  listChildren<Omit<PromptRow, 'createdAt'>>(db, {
    table: 'prompt_batches', columns: 'prompt_id, text, blob_key, origin', idColumn: 'prompt_id', orderColumn: 'created_at',
    map: (r) => ({ promptId: r.prompt_id as string, text: (r.text as string | null) ?? null, blobKey: (r.blob_key as string | null) ?? null, origin: r.origin as string }),
  }, scope, sessionId, opts);

export const listToolCalls = (db: D1Like, scope: ReadScope, sessionId: string, opts?: { limit?: number; cursor?: string }) =>
  listChildren<Omit<ToolCallRow, 'createdAt'>>(db, {
    table: 'tool_calls', columns: 'tool_call_id, tool_name', idColumn: 'tool_call_id', orderColumn: 'created_at',
    map: (r) => ({ toolCallId: r.tool_call_id as string, toolName: r.tool_name as string }),
  }, scope, sessionId, opts);

export const listResponses = (db: D1Like, scope: ReadScope, sessionId: string, opts?: { limit?: number; cursor?: string }) =>
  listChildren<Omit<ResponseRow, 'createdAt'>>(db, {
    table: 'responses', columns: 'response_id, prompt_id, text, blob_key', idColumn: 'response_id', orderColumn: 'created_at',
    map: (r) => ({
      responseId: r.response_id as string,
      promptId: (r.prompt_id as string | null) ?? null,
      text: (r.text as string | null) ?? null,
      blobKey: (r.blob_key as string | null) ?? null,
    }),
  }, scope, sessionId, opts);

/** Plans order by `updated_at` — the column `idx_plans_session` indexes — and are keyed by `plan_key`. */
export const listPlans = (db: D1Like, scope: ReadScope, sessionId: string, opts?: { limit?: number; cursor?: string }) =>
  listChildren<Omit<PlanRow, 'createdAt'>>(db, {
    table: 'plans', columns: 'plan_key, title, status, blob_key', idColumn: 'plan_key', orderColumn: 'updated_at',
    map: (r) => ({
      planKey: r.plan_key as string,
      title: (r.title as string | null) ?? null,
      status: r.status as string,
      blobKey: (r.blob_key as string | null) ?? null,
    }),
  }, scope, sessionId, opts);

export const listAttachments = (db: D1Like, scope: ReadScope, sessionId: string, opts?: { limit?: number; cursor?: string }) =>
  listChildren<Omit<AttachmentRow, 'createdAt'>>(db, {
    table: 'attachments', columns: 'attachment_id, blob_key, media_type, byte_size, description', idColumn: 'attachment_id', orderColumn: 'created_at',
    map: (r) => ({
      attachmentId: r.attachment_id as string,
      blobKey: r.blob_key as string,
      mediaType: r.media_type as string,
      byteSize: r.byte_size as number,
      description: (r.description as string | null) ?? null,
    }),
  }, scope, sessionId, opts);
