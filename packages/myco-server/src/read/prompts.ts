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
import { keyset, page, type Page, type ReadScope } from './scope.js';

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

/**
 * The prompts extraction has not read, oldest first.
 *
 * Oldest first: the cursor walks a backlog forward. Every other page in the
 * server reads newest first, and this is the one that must not skip the middle
 * when new prompts land mid-pass.
 */
export async function listUnprocessedPrompts(
  db: RelationalStore,
  scope: ReadScope,
  opts: UnprocessedOptions = {},
): Promise<Page<UnprocessedPrompt>> {
  const k = keyset(opts, { order: 'p.created_at', id: 'p.prompt_id', direction: 'ASC' });
  if (k === null) return { rows: [], cursor: null };

  const conditions = ['p.project_id = ?', 'p.processed = 0', notTombstonedSql('s')];
  const params: unknown[] = [scope.projectId];
  conditions.push(`p.origin IN (${READ_ORIGINS.map(() => '?').join(', ')})`);
  params.push(...READ_ORIGINS);
  if (opts.includeActive !== true) conditions.push('s.ended_at IS NOT NULL');
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

/** Mark one prompt read. False when this Project holds no such prompt, so a caller never reads a miss as a move. */
export async function markPromptProcessed(db: RelationalStore, scope: ReadScope, promptId: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE prompt_batches SET processed = 1 WHERE project_id = ? AND prompt_id = ?')
    .bind(scope.projectId, promptId)
    .run();
  return result.meta.changes === 1;
}
