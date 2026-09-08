/**
 * `myco_run_prompts`: the extraction cursor.
 *
 * A page walks forward through the prompts extraction has not read, oldest
 * first, and `mark_processed` removes one from the next page. Which origins the
 * page carries is the read layer's decision (`read/prompts.ts`), not an
 * argument: a caller-settable read discipline is one waiting to be turned off.
 *
 * A prompt's body is opt-in. Server text may live in a blob, so a page without
 * it reads no bodies at all, and grouping a session's prompts costs nothing.
 */
import { listUnprocessedPrompts, markPromptProcessed } from '../../read/prompts.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const MAX_ID_CHARS = 192;
const MAX_CURSOR_CHARS = 256;

const str = (v: unknown, max: number): string | undefined =>
  (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

export async function handleRunPrompts(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_prompts');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;

  if (input.op === 'mark_processed') {
    const promptId = str(input.prompt_id, MAX_ID_CHARS);
    if (promptId === undefined) return failure('prompt_id is required for op: mark_processed');
    return { prompt_id: promptId, marked: await markPromptProcessed(db, scope, promptId) };
  }

  const cursor = input.cursor === undefined ? undefined : str(input.cursor, MAX_CURSOR_CHARS);
  if (input.cursor !== undefined && cursor === undefined) return failure('cursor is the next_cursor from a previous page');
  const limit = Math.min(Math.max(int(input.limit) ?? run.window.promptPage, 1), run.window.promptPage);
  const page = await listUnprocessedPrompts(db, scope, {
    limit,
    cursor,
    includeActive: input.include_active === true,
    includeText: input.include_text === true,
  });
  return {
    prompts: page.rows.map((row) => ({
      prompt_id: row.promptId,
      session_id: row.sessionId,
      created_at: row.createdAt,
      ended_at: row.endedAt,
      ...(row.text === undefined ? {} : { text: row.text }),
    })),
    next_cursor: page.cursor,
  };
}
