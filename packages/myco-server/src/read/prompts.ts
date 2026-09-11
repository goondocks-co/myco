/**
 * The extraction cursor: which prompts a run has not read yet, and marking one read.
 *
 * `prompt_batches.processed` is one flag per row, not one per task. A Deployment
 * runs a single extraction outcome, so one flag is the whole answer; a second
 * reader would need a second column and this module would be the place to add
 * it.
 *
 * Which origins extraction reads is declared here as a map over the whole
 * vocabulary rather than a filter, so a new origin fails the completeness gate
 * until someone decides whether extraction wants it.
 */
import type { RelationalStore } from '../core/adapters.js';
import { MATERIAL_EXCERPT_CHARS } from '../constants.js';
import { PROMPT_ORIGINS } from '../ingest/kinds.js';
import { notTombstonedSql } from '../core/tombstones.js';
import { clampLimit, decodeCursor, encodeCursor, keyset, page, type Page, type ReadScope } from './scope.js';

/**
 * Whether extraction reads a prompt of each origin.
 *
 * `system` carries harness-injected envelopes, `agent_dispatch` a subagent's
 * return prompt and `hook_injected` Myco's own injection: none is a person
 * speaking, and reasoning over them spends turns on text nobody wrote.
 * `unknown` IS read — it is a parse fallback that may hold a real prompt, and
 * excluding it would drop that prompt from extraction for good, which is the
 * costlier direction of the two.
 */
export const EXTRACTION_ORIGINS: Readonly<Record<(typeof PROMPT_ORIGINS)[number], boolean>> = {
  user: true,
  unknown: true,
  system: false,
  agent_dispatch: false,
  hook_injected: false,
};

/** The origins an extraction page carries. */
export const READ_ORIGINS: readonly string[] = PROMPT_ORIGINS.filter((origin) => EXTRACTION_ORIGINS[origin]);

const ELIGIBLE_PROMPT_SQL = `p.processed = 0 AND p.origin IN (${READ_ORIGINS.map(() => '?').join(', ')})`;

/** One unprocessed prompt. `text` and `response` are present only where the caller asked for bodies. */
export interface UnprocessedPrompt {
  promptId: string;
  sessionId: string;
  createdAt: number;
  endedAt: number | null;
  text?: string | null;
  /** The opening of the agent's first response to this prompt, cut to the material excerpt; null where the Project holds no response to it. */
  response?: string | null;
}

export interface UnprocessedOptions {
  limit?: number;
  cursor?: string;
  /** Prompts of sessions still in flight; excluded unless asked for. */
  includeActive?: boolean;
  /** The prompt body, read only when asked: a page without it reads no blobs. */
  includeText?: boolean;
}

type SessionSelection = { id: string; exclude: boolean };

/** One chronological partition of eligible prompts. */
async function readUnprocessedPrompts(
  db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions, session?: SessionSelection,
): Promise<Page<UnprocessedPrompt>> {
  const k = keyset(opts, { order: 'p.created_at', id: 'p.prompt_id', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };

  const conditions = ['p.project_id = ?', ELIGIBLE_PROMPT_SQL, notTombstonedSql('s')];
  const params: unknown[] = [scope.projectId, ...READ_ORIGINS];
  if (opts.includeActive !== true) conditions.push('s.ended_at IS NOT NULL');
  if (session !== undefined) { conditions.push(`p.session_id ${session.exclude ? '!=' : '='} ?`); params.push(session.id); }
  if (k.where !== '') { conditions.push(k.where); params.push(...k.params); }

  // A body page carries the prompt and the opening of its first response: the
  // ask and what the agent found, which is the material an observation is read
  // from. A page without bodies reads neither.
  const body = opts.includeText === true
    ? `, p.text AS text, (SELECT substr(r.text, 1, ?) FROM responses r
         WHERE r.project_id = p.project_id AND r.session_id = p.session_id AND r.prompt_id = p.prompt_id AND r.text IS NOT NULL
         ORDER BY r.created_at, r.response_id LIMIT 1) AS response`
    : '';
  const bodyParams: unknown[] = opts.includeText === true ? [MATERIAL_EXCERPT_CHARS] : [];
  const { results } = await db
    .prepare(`SELECT p.prompt_id AS promptId, p.session_id AS sessionId, p.created_at AS createdAt, p.ended_at AS endedAt${body}
                FROM prompt_batches p JOIN sessions s ON s.project_id = p.project_id AND s.session_id = p.session_id
               WHERE ${conditions.join(' AND ')}
               ORDER BY p.created_at ASC, p.prompt_id ASC LIMIT ?`)
    .bind(...bodyParams, ...params, k.limit + 1)
    .all<Record<string, unknown>>();

  const rows = results.map((row): UnprocessedPrompt => ({
    promptId: row.promptId as string,
    sessionId: row.sessionId as string,
    createdAt: row.createdAt as number,
    endedAt: (row.endedAt as number | null) ?? null,
    ...(opts.includeText === true ? { text: (row.text as string | null) ?? null, response: (row.response as string | null) ?? null } : {}),
  }));
  return page(rows, k.limit, (r) => ({ createdAt: r.createdAt, id: r.promptId }));
}

/** One quarter of a normal extraction page is reserved for historical work. */
const HISTORY_PAGE_DIVISOR = 4;
const EXTRACTION_CURSOR_PREFIX = 'ex1:';
/** False marks an exhausted partition; null starts it; a string continues its keyset. */
type PartitionCursor = string | null | false;
type ExtractionCursor = [sessionId: string, fresh: PartitionCursor, history: PartitionCursor];

function extractionCursor(value: string): ExtractionCursor | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value.slice(EXTRACTION_CURSOR_PREFIX.length)); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== 'string' || parsed[0].length === 0) return null;
  const valid = (part: unknown): part is PartitionCursor => part === null || part === false || (typeof part === 'string' && decodeCursor(part) !== null);
  return valid(parsed[1]) && valid(parsed[2]) ? [parsed[0], parsed[1], parsed[2]] : null;
}

function advancePartition(before: PartitionCursor, result: Page<UnprocessedPrompt>, taken: number): PartitionCursor {
  if (taken === result.rows.length && result.cursor === null) return false;
  const last = result.rows[taken - 1];
  return last === undefined ? before : encodeCursor(last.createdAt, last.promptId);
}

/**
 * The newest completed session gets the first three quarters of a page; older
 * sessions get the remainder. Unused space is shared. Each partition stays in
 * prompt order, and a cursor pins the chosen session across subsequent pages.
 */
export async function listUnprocessedPrompts(
  db: RelationalStore, scope: ReadScope, opts: UnprocessedOptions = {},
): Promise<Page<UnprocessedPrompt>> {
  if (opts.cursor !== undefined && !opts.cursor.startsWith(EXTRACTION_CURSOR_PREFIX)) return readUnprocessedPrompts(db, scope, opts);
  let cursor: ExtractionCursor | null;
  if (opts.cursor !== undefined) {
    cursor = extractionCursor(opts.cursor);
    if (cursor === null) throw new Error('Invalid extraction cursor');
  } else {
    const newest = await db.prepare(`SELECT s.session_id AS id FROM
      (SELECT DISTINCT p.session_id FROM prompt_batches p WHERE p.project_id = ? AND ${ELIGIBLE_PROMPT_SQL}) candidates
      JOIN sessions s ON s.session_id = candidates.session_id
      WHERE s.project_id = ? AND s.ended_at IS NOT NULL AND ${notTombstonedSql('s')}
      ORDER BY s.ended_at DESC, s.session_id DESC LIMIT 1`).bind(scope.projectId, ...READ_ORIGINS, scope.projectId).first<{ id: string }>();
    if (newest === null) return readUnprocessedPrompts(db, scope, opts);
    cursor = [newest.id, null, null];
  }
  const [sessionId, freshAfter, historyAfter] = cursor;
  const limit = clampLimit(opts.limit);
  const readPartition = (after: PartitionCursor, exclude: boolean): Promise<Page<UnprocessedPrompt>> => after === false
    ? Promise.resolve({ rows: [], cursor: null })
    : readUnprocessedPrompts(db, scope, { ...opts, limit, cursor: after ?? undefined }, { id: sessionId, exclude });
  const [fresh, history] = await Promise.all([readPartition(freshAfter, false), readPartition(historyAfter, true)]);
  const reservedHistory = limit === 1 ? 0 : Math.max(1, Math.floor(limit / HISTORY_PAGE_DIVISOR));
  const historyCount = Math.min(history.rows.length, limit - Math.min(fresh.rows.length, limit - reservedHistory));
  const freshCount = Math.min(fresh.rows.length, limit - historyCount);
  const next: ExtractionCursor = [sessionId, advancePartition(freshAfter, fresh, freshCount), advancePartition(historyAfter, history, historyCount)];
  return {
    rows: [...fresh.rows.slice(0, freshCount), ...history.rows.slice(0, historyCount)],
    cursor: next[1] === false && next[2] === false ? null : `${EXTRACTION_CURSOR_PREFIX}${JSON.stringify(next)}`,
  };
}

/** Mark one prompt read. False when this Project holds no such prompt, so a caller never reads a miss as a move. */
export async function markPromptProcessed(db: RelationalStore, scope: ReadScope, promptId: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE prompt_batches SET processed = 1 WHERE project_id = ? AND prompt_id = ?')
    .bind(scope.projectId, promptId)
    .run();
  return result.meta.changes === 1;
}
