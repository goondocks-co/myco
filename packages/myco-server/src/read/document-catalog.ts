/**
 * Session reads served by the document catalog alone: the turn list, prompt membership and a session's counters. No
 * statement here reads a record body or scans a table that grows with content; each is bounded by its page or point key.
 */
import type { CardMarks } from '../core/turn-cards.js';
import type { ToolRollup } from '../content/tool-rollup.js';
import { PROMPT_ORIGINS } from '../ingest/kinds.js';
import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from './scope.js';

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
  headline: string | null;
  signal: 'high' | 'low' | 'none' | null;
  marks: CardMarks | null;
  failedTools: number;
  mycoCalls: number;
  toolRollup: ToolRollup | null;
}

/**
 * A session's turns of the named origins in turn order, read from its top-level prompt rows; `promptId` names any
 * prompt of the turn to return. At most one page of prompt rows is read.
 */
export interface TurnOptions {
  origins: readonly string[]; limit?: number; cursor?: string; order?: 'ASC' | 'DESC'; promptId?: string;
  filter?: 'key' | 'failed' | 'myco'; around?: string;
}

export async function listCatalogTurns(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: TurnOptions): Promise<Page<CatalogTurnRow>> {
  const limit = clampLimit(opts.limit);
  const direction = opts.order ?? 'ASC';
  if (opts.origins.length === 0) return { rows: [], cursor: null };
  const key = opts.filter === 'key';
  const userOnly = opts.origins.length === 1 && opts.origins[0] === 'user';
  const allOrigins = PROMPT_ORIGINS.every(origin => opts.origins.includes(origin));
  const column = key ? 'c.created_at' : 'p.ord';
  const id = key ? 'c.turn_key' : 'p.prompt_id';
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && cursor === null) return { rows: [], cursor: null };
  const exactTurn = opts.promptId === undefined ? undefined : await promptTurn(db, scope, sessionId, opts.promptId);
  if (opts.promptId !== undefined && exactTurn == null) return { rows: [], cursor: null };
  const read = async (take: number, order: 'ASC' | 'DESC', boundary: { createdAt: number; id: string } | null, inclusive = false, exact = false) => {
    const conditions = [`p.project_id = ?1`, `p.session_id = ?2`, `p.generation = ${liveGenerationSql('?1', '?2')}`, `p.turn_key = p.prompt_id`];
    const params: unknown[] = [scope.projectId, sessionId];
    if (userOnly) conditions.push(`p.origin='user'`);
    else if (!allOrigins) {
      params.push(JSON.stringify(opts.origins));
      conditions.push(`p.origin IN (SELECT value FROM json_each(?${params.length}))`);
    }
    if (key) conditions.push(`c.project_id = ?1`, `c.session_id = ?2`, `c.signal = 'high'`);
    if (opts.filter === 'failed') conditions.push('p.failed_tools > 0');
    if (opts.filter === 'myco') conditions.push('p.myco_calls > 0');
    if (exactTurn !== undefined) {
      params.push(exactTurn);
      conditions.push(`p.prompt_id=?${params.length}`);
    }
    if (boundary !== null) {
      params.push(boundary.createdAt, boundary.id);
      const compare = (order === 'ASC' ? '>' : '<') + (inclusive ? '=' : '');
      conditions.push(`(${column},${id}) ${compare} (?${params.length - 1},?${params.length})`);
    }
    params.push(take + (exact ? 0 : 1));
    const source = key && exactTurn === undefined
      ? `turn_cards c INDEXED BY idx_turn_cards_key CROSS JOIN session_prompts p
          ON p.project_id=c.project_id AND p.session_id=c.session_id AND p.prompt_id=c.turn_key`
      : `session_prompts p ${exactTurn !== undefined ? '' : opts.filter ? `INDEXED BY idx_session_prompts_${opts.filter}` : userOnly ? 'INDEXED BY idx_session_prompts_user_turns' : ''}
          LEFT JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.prompt_id`;
    const { results } = await db.prepare(`SELECT p.prompt_id,p.origin,p.prompt_kind,p.thread_label,p.preview,p.text_chars,p.created_at,
        ${column} AS position,p.tools,p.replies,p.children,p.plans,p.failed_tools,p.myco_calls,p.tool_rollup,c.headline,c.signal,c.marks,
        (SELECT COUNT(*) FROM attachments a WHERE a.project_id=p.project_id AND a.session_id=p.session_id AND a.prompt_id=p.prompt_id) AS attachments
      FROM ${source} WHERE ${conditions.join(' AND ')}
      ORDER BY ${column} ${order},${id} ${order} LIMIT ?${params.length}`).bind(...params).all<Record<string, unknown>>();
    return results.map(r => ({
      promptId: String(r.prompt_id), origin: String(r.origin ?? 'user'), promptKind: (r.prompt_kind as string | null) ?? null,
      threadLabel: (r.thread_label as string | null) ?? null, preview: (r.preview as string | null) ?? null,
      textChars: (r.text_chars as number | null) ?? null, blobKey: null, createdAt: Number(r.created_at),
      toolCallCount: Number(r.tools), responseCount: Number(r.replies), childCount: Number(r.children), planCount: Number(r.plans),
      attachmentCount: Number(r.attachments), position: Number(r.position), headline: (r.headline as string | null) ?? null,
      signal: (r.signal as CatalogTurnRow['signal']) ?? null, marks: r.marks == null ? null : JSON.parse(String(r.marks)) as CardMarks,
      failedTools: Number(r.failed_tools), mycoCalls: Number(r.myco_calls),
      toolRollup: r.tool_rollup == null ? null : JSON.parse(String(r.tool_rollup)) as ToolRollup,
    }));
  };
  let rows;
  if (opts.around !== undefined) {
    const target = await promptTurn(db, scope, sessionId, opts.around);
    if (target == null) return { rows: [], cursor: null };
    const anchor = await db.prepare(`SELECT p.ord,c.created_at,p.prompt_id FROM session_prompts p
      LEFT JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.turn_key
      WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=${liveGenerationSql('?1', '?2')}
        AND p.prompt_id=?3`).bind(scope.projectId, sessionId, target)
      .first<{ ord: number; created_at: number | null; prompt_id: string }>();
    if (anchor === null || (key && anchor.created_at === null)) return { rows: [], cursor: null };
    const at = { createdAt: key ? anchor.created_at! : anchor.ord, id: anchor.prompt_id };
    const before = await read(Math.floor(limit / 2), direction === 'ASC' ? 'DESC' : 'ASC', at, false, true);
    const after = await read(limit - before.length, direction, at, true);
    rows = [...before.reverse(), ...after];
  } else rows = await read(limit, direction, cursor);
  const paged = page(rows, limit, r => ({ createdAt: r.position, id: r.promptId }));
  return { cursor: paged.cursor, rows: paged.rows.map(({ position: _position, ...row }) => row) };
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
  filesEdited: number;
  mycoCalls: number;
  plans: number;
  attachments: number;
  lastRecordAt: number | null;
  firstPrompt: string | null;
}

/** A session's document counters and attachment count, or null while it has no live document. */
export async function documentCounters(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<DocumentCounters | null> {
  const row = await db.prepare(`SELECT prompts, user_prompts, replies, tool_calls, failed_tools, files_edited, myco_calls, plans, last_record_at, first_prompt,
      (SELECT COUNT(*) FROM attachments a WHERE a.project_id = d.project_id AND a.session_id = d.session_id) AS attachments
    FROM session_documents d WHERE project_id = ? AND session_id = ? AND state = 'live'`).bind(scope.projectId, sessionId).first<Record<string, number | string | null>>();
  return row === null ? null : {
    prompts: Number(row.prompts), userPrompts: Number(row.user_prompts), replies: Number(row.replies), toolCalls: Number(row.tool_calls),
    failedTools: Number(row.failed_tools), filesEdited: Number(row.files_edited), mycoCalls: Number(row.myco_calls), plans: Number(row.plans), attachments: Number(row.attachments), lastRecordAt: (row.last_record_at as number | null) ?? null,
    firstPrompt: (row.first_prompt as string | null) ?? null,
  };
}

/** True when the session's live document holds a user prompt. */
export async function sessionHasUserPrompt(db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS held FROM session_documents WHERE project_id = ? AND session_id = ? AND state = 'live' AND user_prompts > 0`)
    .bind(projectId, sessionId).first<{ held: number }>();
  return row !== null;
}
