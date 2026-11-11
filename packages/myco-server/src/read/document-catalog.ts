/**
 * Session reads served by the document catalog alone: the turn list, prompt membership and a session's counters. No
 * statement here reads a record body or scans a table that grows with content; each is bounded by its page or point key.
 */
import type { CardMarks } from '../core/turn-cards.js';
import type { ToolRollup } from '../content/tool-rollup.js';
import { PROMPT_ORIGINS } from '../ingest/kinds.js';
import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from './scope.js';
import { documentCountersRow, liveDocumentHasUserPrompt, turnAnchor } from '../db/documents/catalog-reads.js';
import { promptLocator } from '../db/documents/prompt-locator.js';
import { turnPageRows, type OriginScope } from '../db/documents/turn-pages.js';

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
interface TurnOptions {
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
  const origins: OriginScope = userOnly ? 'user' : allOrigins ? 'all' : opts.origins;
  const cursor = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && cursor === null) return { rows: [], cursor: null };
  const exact = opts.promptId === undefined ? undefined : await promptLocator(db, scope.projectId, sessionId, opts.promptId);
  if (exact === null || (exact !== undefined && exact.turn === null)) return { rows: [], cursor: null };
  const exactTurn = exact?.turn ?? undefined;
  const read = async (take: number, order: 'ASC' | 'DESC', boundary: { createdAt: number; id: string } | null, inclusive = false, exact = false) => {
    const results = await turnPageRows(db, { project: scope.projectId, session: sessionId, filter: opts.filter, origins, turn: exactTurn, order,
      boundary: boundary === null ? null : { ...boundary, inclusive }, limit: take + (exact ? 0 : 1) });
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
    const target = (await promptLocator(db, scope.projectId, sessionId, opts.around))?.turn;
    if (target == null) return { rows: [], cursor: null };
    const anchor = await turnAnchor(db, scope.projectId, sessionId, target);
    if (anchor === null || (key && anchor.created_at === null)) return { rows: [], cursor: null };
    const at = { createdAt: key ? anchor.created_at! : anchor.ord, id: anchor.prompt_id };
    const before = await read(Math.floor(limit / 2), direction === 'ASC' ? 'DESC' : 'ASC', at, false, true);
    const after = await read(limit - before.length, direction, at, true);
    rows = [...before.reverse(), ...after];
  } else rows = await read(limit, direction, cursor);
  const paged = page(rows, limit, r => ({ createdAt: r.position, id: r.promptId }));
  return { cursor: paged.cursor, rows: paged.rows.map(({ position: _position, ...row }) => row) };
}

interface DocumentCounters {
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
  const row = await documentCountersRow(db, scope.projectId, sessionId);
  return row === null ? null : {
    prompts: Number(row.prompts), userPrompts: Number(row.user_prompts), replies: Number(row.replies), toolCalls: Number(row.tool_calls),
    failedTools: Number(row.failed_tools), filesEdited: Number(row.files_edited), mycoCalls: Number(row.myco_calls), plans: Number(row.plans), attachments: Number(row.attachments), lastRecordAt: (row.last_record_at as number | null) ?? null,
    firstPrompt: (row.first_prompt as string | null) ?? null,
  };
}

/** True when the session's live document holds a user prompt. */
export const sessionHasUserPrompt = (db: RelationalStore, projectId: string, sessionId: string): Promise<boolean> => liveDocumentHasUserPrompt(db, projectId, sessionId);
