/**
 * Session reads served by the document catalog alone: the turn list, prompt membership and a session's counters. No
 * statement here reads a record body or scans a table that grows with content; each is bounded by its page or point key.
 */
import type { RelationalStore } from '../core/adapters.js';
import { keyset, page, type Page, type ReadScope } from './scope.js';

/** The live generation of a session's document, as a scalar subquery over `project` and `session` expressions. */
export const liveGenerationSql = (project: string, session: string): string =>
  `(SELECT generation FROM session_documents WHERE project_id = ${project} AND session_id = ${session} AND state = 'live')`;

/** True when a prompt of that id sits in the session's live document; the expressions name the hint being placed. */
export function placedPromptSql(hint: { project: string; session: string; prompt: string }): string {
  return `EXISTS (SELECT 1 FROM session_prompts placed WHERE placed.project_id = ${hint.project} AND placed.session_id = ${hint.session}
    AND placed.generation = ${liveGenerationSql(hint.project, hint.session)} AND placed.prompt_id = ${hint.prompt})`;
}

export interface CatalogTurnRow {
  promptId: string;
  origin: string;
  promptKind: string | null;
  threadLabel: string | null;
  preview: string | null;
  textChars: number | null;
  blobKey: string | null;
  createdAt: number;
  toolCallCount: number;
  responseCount: number;
  childCount: number;
  planCount: number;
  attachmentCount: number;
}

/**
 * A session's turns of the named origins in turn order, read from its top-level prompt rows; `promptId` names any
 * prompt of the turn to return. At most one page of prompt rows is read.
 */
export async function listCatalogTurns(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: { origins: readonly string[]; limit?: number; cursor?: string; order?: 'ASC' | 'DESC'; promptId?: string }): Promise<Page<CatalogTurnRow>> {
  const direction = opts.order ?? 'ASC';
  const k = keyset(opts, { order: 'p.ord', id: 'p.prompt_id', direction });
  if (k === null || opts.origins.length === 0) return { rows: [], cursor: null };
  const conditions = [`p.project_id = ?1`, `p.session_id = ?2`, `p.generation = ${liveGenerationSql('?1', '?2')}`, `p.turn_key = p.prompt_id`,
    `p.origin IN (SELECT value FROM json_each(?3))`];
  const params: unknown[] = [scope.projectId, sessionId, JSON.stringify(opts.origins)];
  if (opts.promptId !== undefined) {
    params.push(opts.promptId);
    conditions.push(`p.prompt_id = (SELECT turn_key FROM session_prompts n WHERE n.project_id = ?1 AND n.session_id = ?2
      AND n.generation = p.generation AND n.prompt_id = ?${params.length})`);
  }
  let where = k.where;
  for (const value of k.params) { params.push(value); where = where.replace('?', `?${params.length}`); }
  if (where !== '') conditions.push(where);
  params.push(k.limit + 1);
  const { results } = await db.prepare(`SELECT p.prompt_id, p.origin, p.prompt_kind, p.thread_label, p.preview, p.text_chars, p.created_at, p.ord,
      p.tools, p.replies, p.children, p.plans,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id = p.project_id AND a.session_id = p.session_id AND a.prompt_id = p.prompt_id) AS attachments
    FROM session_prompts p WHERE ${conditions.join(' AND ')}
    ORDER BY p.ord ${direction}, p.prompt_id ${direction} LIMIT ?${params.length}`).bind(...params).all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    promptId: String(r.prompt_id), origin: String(r.origin ?? 'user'), promptKind: (r.prompt_kind as string | null) ?? null,
    threadLabel: (r.thread_label as string | null) ?? null, preview: (r.preview as string | null) ?? null,
    textChars: (r.text_chars as number | null) ?? null, blobKey: null, createdAt: Number(r.created_at),
    toolCallCount: Number(r.tools), responseCount: Number(r.replies), childCount: Number(r.children), planCount: Number(r.plans),
    attachmentCount: Number(r.attachments), ord: Number(r.ord),
  }));
  const paged = page(rows, k.limit, (r) => ({ createdAt: r.ord, id: r.promptId }));
  return { cursor: paged.cursor, rows: paged.rows.map(({ ord: _ord, ...row }) => row) };
}

/**
 * Where a prompt of the session's live document sits: its turn key (null for a prompt no turn holds) and the page of
 * that owner holding its record (null when not yet recorded, -1 when no page holds it); undefined when the prompt is absent.
 */
export async function promptPlace(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<{ turn: string | null; page: number | null } | undefined> {
  const row = await db.prepare(`SELECT turn_key, page FROM session_prompts WHERE project_id = ?1 AND session_id = ?2
    AND generation = ${liveGenerationSql('?1', '?2')} AND prompt_id = ?3`).bind(scope.projectId, sessionId, promptId).first<{ turn_key: string | null; page: number | null }>();
  return row === null ? undefined : { turn: row.turn_key, page: row.page };
}

/** The turn a prompt of the session's live document belongs to: its turn key, null for a prompt no turn holds, or undefined when absent. */
export async function promptTurn(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<string | null | undefined> {
  return (await promptPlace(db, scope, sessionId, promptId))?.turn;
}

/** True when a prompt of that id sits in the session's live document. */
export async function promptInDocument(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<boolean> {
  return (await promptTurn(db, scope, sessionId, promptId)) !== undefined;
}

export interface DocumentCounters {
  prompts: number;
  userPrompts: number;
  replies: number;
  toolCalls: number;
  failedTools: number;
  plans: number;
  attachments: number;
  lastRecordAt: number | null;
  firstPrompt: string | null;
}

/** A session's document counters and attachment count, or null while it has no live document. */
export async function documentCounters(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<DocumentCounters | null> {
  const row = await db.prepare(`SELECT prompts, user_prompts, replies, tool_calls, failed_tools, plans, last_record_at, first_prompt,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id = d.project_id AND a.session_id = d.session_id) AS attachments
    FROM session_documents d WHERE project_id = ? AND session_id = ? AND state = 'live'`).bind(scope.projectId, sessionId).first<Record<string, number | string | null>>();
  return row === null ? null : {
    prompts: Number(row.prompts), userPrompts: Number(row.user_prompts), replies: Number(row.replies), toolCalls: Number(row.tool_calls),
    failedTools: Number(row.failed_tools), plans: Number(row.plans), attachments: Number(row.attachments), lastRecordAt: (row.last_record_at as number | null) ?? null,
    firstPrompt: (row.first_prompt as string | null) ?? null,
  };
}
