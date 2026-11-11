import type { RelationalStore as children_import_RelationalStore } from "../../core/adapters.js";
import { clampLimit as children_import_clampLimit, decodeCursor as children_import_decodeCursor } from "../scope.js";
import { attachmentChildRows, contextInjectionChildRows } from "../../db/sessions/session-children.js";
import { page as children_import_page } from "../scope.js";
import type { Page as children_import_Page } from "../scope.js";
import type { ReadScope as children_import_ReadScope } from "../scope.js";

/** Paging plus, for the tables that carry one, the prompt whose children the page is narrowed to; `idx_tool_calls_prompt` and `idx_attachments_prompt` serve the narrowed order. */
interface children_ChildOptions { limit?: number; cursor?: string; promptId?: string }

/** `promptId` names the session prompt the attachment's captured hint resolves to; an unplaced attachment carries null. */
interface children_AttachmentRow { attachmentId: string; promptId: string | null; blobKey: string; mediaType: string; byteSize: number; description: string | null; createdAt: number; orderedAt: number }

/**
 * A record of what Myco served the session as a whole: a session-level block (`kind` names it: `cortex` for the start,
 * `cortex:<agent>` for a sub-agent's, `plan-nudge`), or context no named prompt received (`kind` is `context:<row
 * id>`): an answer, or a receipt no answer names, which outlives the answers' retention. `delivery` says whether it
 * reached the agent with no matching prompt in this session, or has no reported delivery.
 */
interface children_ContextInjectionRow { kind: string; createdAt: number; orderedAt: number; delivery: 'unnamed_prompt' | 'not_delivered' | null }

/** Paging alone, for a table with no prompt column to narrow by. */
type children_PagingOptions = Pick<children_ChildOptions, 'limit' | 'cursor'>;

/** The page size and the key the cursor names, or null for a malformed cursor. */
function children_paging(opts: children_ChildOptions): { limit: number; after: { createdAt: number; id: string } | null } | null {
  const limit = children_import_clampLimit(opts.limit);
  if (opts.cursor === undefined) return { limit, after: null };
  const after = children_import_decodeCursor(opts.cursor);
  return after === null ? null : { limit, after };
}

async function children_listContextInjections(db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts: children_PagingOptions = {}): Promise<children_import_Page<children_ContextInjectionRow>> {
  const paging = children_paging(opts);
  if (paging === null) return { rows: [], cursor: null };
  const results = await contextInjectionChildRows(db, { project: scope.projectId, session: sessionId, after: paging.after, limit: paging.limit + 1 });
  const rows = results.map((r) => ({ kind: r.kind, createdAt: r.created_at, delivery: r.delivery ?? null, orderedAt: r.order_at }));
  const paged = children_import_page(rows, paging.limit, (r) => ({ createdAt: r.orderedAt, id: r.kind }));
  return { rows: paged.rows, cursor: paged.cursor };
}

async function children_listAttachments(db: children_import_RelationalStore, scope: children_import_ReadScope, sessionId: string, opts: children_ChildOptions = {}): Promise<children_import_Page<Omit<children_AttachmentRow, 'orderedAt'> & { orderedAt: number }>> {
  const paging = children_paging(opts);
  if (paging === null) return { rows: [], cursor: null };
  const results = await attachmentChildRows(db, { project: scope.projectId, session: sessionId, after: paging.after, limit: paging.limit + 1, prompt: opts.promptId });
  const rows = results.map((r) => ({
    createdAt: r.created_at, attachmentId: r.attachment_id, promptId: r.prompt_id ?? null, blobKey: r.blob_key, mediaType: r.media_type,
    byteSize: r.byte_size, description: r.description ?? null, orderedAt: r.order_at,
  }));
  const paged = children_import_page(rows, paging.limit, (r) => ({ createdAt: r.orderedAt, id: r.attachmentId }));
  return { rows: paged.rows, cursor: paged.cursor };
}

export { children_listContextInjections, children_listAttachments };
