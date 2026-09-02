/**
 * A session read as turns: each top-level prompt with what followed it — the
 * tool calls, responses, attachments and steering prompts that name it. The
 * dashboard's session page renders the list collapsed (a preview per turn) and
 * fetches one turn's body when it opens, so the list carries counts and a
 * preview, never a prompt's full text.
 */
import type { RelationalStore } from '../core/adapters.js';
import { PROMPT_ORIGINS } from '../ingest/kinds.js';
import { ATTACHMENT_QUERY, PLAN_QUERY, RESPONSE_QUERY, listChildren, type AttachmentRow, type PlanRow, type ResponseRow } from './children.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** How much of a prompt's inline text the list row carries. */
export const TURN_PREVIEW_CHARS = 160;
/** How many responses, attachments or steering children one turn's body carries; a turn beyond these is read through the paged children. */
export const TURN_BODY_LIMIT = 50;
/** The origin the list shows when the caller names none: what a person typed. */
export const DEFAULT_ORIGINS: readonly string[] = ['user'];

export interface TurnRow {
  promptId: string;
  origin: string;
  promptKind: string | null;
  threadLabel: string | null;
  /** The opening of the inline text; null when the text spilled to a blob. */
  preview: string | null;
  /** The inline text's length in characters; null when it spilled. */
  textChars: number | null;
  blobKey: string | null;
  createdAt: number;
  toolCallCount: number;
  responseCount: number;
  /** Steering and interrupt prompts that name this one as their parent. */
  childCount: number;
  planCount: number;
  attachmentCount: number;
}

export interface TurnPrompt {
  promptId: string;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
}

export interface TurnChild {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  toolCallCount: number;
}

export interface TurnDetail {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  attachments: AttachmentRow[];
  /** The plans this prompt produced, oldest update first. */
  plans: PlanRow[];
  children: TurnChild[];
}

/** The origins a query names, or null when one is not an origin the wire admits. Absent means the default. */
export function parseOrigins(raw: string | null): readonly string[] | null {
  if (raw === null || raw === '') return DEFAULT_ORIGINS;
  const names = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (names.length === 0) return null;
  const admitted = new Set<string>(PROMPT_ORIGINS);
  return names.every((n) => admitted.has(n)) ? [...new Set(names)] : null;
}

const PROMPT_COLUMNS = 'pb.prompt_id, pb.origin, pb.prompt_kind, pb.parent_prompt_id, pb.thread_label, pb.text, pb.blob_key, pb.created_at';

function toPrompt(r: Record<string, unknown>): TurnPrompt {
  return {
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    parentPromptId: (r.parent_prompt_id as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}

const TOOL_CALL_COUNT = `(SELECT COUNT(*) FROM tool_calls t WHERE t.project_id = pb.project_id AND t.session_id = pb.session_id AND t.prompt_id = pb.prompt_id)`;
const RESPONSE_COUNT = `(SELECT COUNT(*) FROM responses r WHERE r.project_id = pb.project_id AND r.prompt_id = pb.prompt_id)`;
const PLAN_COUNT = `(SELECT COUNT(*) FROM plans p WHERE p.project_id = pb.project_id AND p.session_id = pb.session_id AND p.prompt_id = pb.prompt_id)`;
const ATTACHMENT_COUNT = `(SELECT COUNT(*) FROM attachments a WHERE a.project_id = pb.project_id AND a.session_id = pb.session_id AND a.prompt_id = pb.prompt_id)`;
const CHILD_COUNT = `(SELECT COUNT(*) FROM prompt_batches c WHERE c.project_id = pb.project_id AND c.session_id = pb.session_id AND c.parent_prompt_id = pb.prompt_id)`;

/** A session's top-level prompts of the named origins, oldest first, keyset-paged over `idx_prompt_batches_turns`. */
export async function listTurns(db: RelationalStore, scope: ReadScope, sessionId: string, opts: { origins?: readonly string[]; limit?: number; cursor?: string } = {}): Promise<Page<TurnRow>> {
  const k = keyset(opts, { order: 'pb.created_at', id: 'pb.prompt_id', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };
  const origins = opts.origins ?? DEFAULT_ORIGINS;
  if (origins.length === 0) return { rows: [], cursor: null };
  const conditions = ['pb.project_id = ?', 'pb.session_id = ?', 'pb.parent_prompt_id IS NULL', `pb.origin IN (${origins.map(() => '?').join(', ')})`];
  const params: unknown[] = [scope.projectId, sessionId, ...origins];
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }
  const { results } = await db
    .prepare(`SELECT pb.prompt_id, pb.origin, pb.prompt_kind, pb.thread_label, substr(pb.text, 1, ${TURN_PREVIEW_CHARS}) AS preview, length(pb.text) AS text_chars, pb.blob_key, pb.created_at,
                     ${TOOL_CALL_COUNT} AS tool_call_count, ${RESPONSE_COUNT} AS response_count, ${CHILD_COUNT} AS child_count, ${PLAN_COUNT} AS plan_count, ${ATTACHMENT_COUNT} AS attachment_count
                FROM prompt_batches pb
               WHERE ${conditions.join(' AND ')}
               ORDER BY pb.created_at ASC, pb.prompt_id ASC LIMIT ?`)
    .bind(...params, k.limit + 1)
    .all<Record<string, unknown>>();
  const rows: TurnRow[] = results.map((r) => ({
    promptId: r.prompt_id as string,
    origin: r.origin as string,
    promptKind: (r.prompt_kind as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null,
    preview: (r.preview as string | null) ?? null,
    textChars: (r.text_chars as number | null) ?? null,
    blobKey: (r.blob_key as string | null) ?? null,
    createdAt: r.created_at as number,
    toolCallCount: r.tool_call_count as number,
    responseCount: r.response_count as number,
    childCount: r.child_count as number,
    planCount: r.plan_count as number,
    attachmentCount: r.attachment_count as number,
  }));
  return page(rows, k.limit, (r) => ({ createdAt: r.createdAt, id: r.promptId }));
}

/** True when a prompt of that id sits in the session. */
export async function promptInSession(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM prompt_batches WHERE project_id = ? AND session_id = ? AND prompt_id = ?`)
    .bind(scope.projectId, sessionId, promptId)
    .first<{ present: number }>();
  return row !== null;
}

/** One turn's body, or null when no prompt of that id sits in the session. Tool calls are not here: they are read on their own, page by page, when the reader opens them. */
export async function turnDetail(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<TurnDetail | null> {
  const row = await db
    .prepare(`SELECT ${PROMPT_COLUMNS} FROM prompt_batches pb WHERE pb.project_id = ? AND pb.session_id = ? AND pb.prompt_id = ?`)
    .bind(scope.projectId, sessionId, promptId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const prompt = toPrompt(row);
  const body = { limit: TURN_BODY_LIMIT };
  const [responses, attachments, plans, childRows] = await Promise.all([
    listChildren(db, RESPONSE_QUERY, scope, sessionId, { ...body, promptId }),
    listChildren(db, ATTACHMENT_QUERY, scope, sessionId, { ...body, promptId }),
    listChildren(db, PLAN_QUERY, scope, sessionId, { ...body, promptId }),
    db.prepare(`SELECT ${PROMPT_COLUMNS}, ${TOOL_CALL_COUNT} AS tool_call_count FROM prompt_batches pb
                 WHERE pb.project_id = ? AND pb.session_id = ? AND pb.parent_prompt_id = ?
                 ORDER BY pb.created_at ASC, pb.prompt_id ASC LIMIT ?`)
      .bind(scope.projectId, sessionId, promptId, TURN_BODY_LIMIT)
      .all<Record<string, unknown>>(),
  ]);
  const children: TurnChild[] = [];
  for (const child of childRows.results) {
    const childPrompt = toPrompt(child);
    const childResponses = await listChildren(db, RESPONSE_QUERY, scope, sessionId, { ...body, promptId: childPrompt.promptId });
    children.push({ prompt: childPrompt, responses: [...childResponses.rows], toolCallCount: child.tool_call_count as number });
  }
  return { prompt, responses: [...responses.rows], attachments: [...attachments.rows], plans: [...plans.rows], children };
}
