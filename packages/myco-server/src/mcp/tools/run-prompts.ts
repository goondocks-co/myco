/** A run acknowledges only material its ledger admits. */
import { acknowledgePrompt } from '../../core/extraction-acks.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const MAX_ID_CHARS = 192;
const str = (v: unknown, max: number): string | undefined =>
  (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

export async function handleRunPrompts(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_prompts');
  if (input.op !== 'mark_processed') return failure('unknown prompt operation');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const servedId = str(input.served_id, MAX_ID_CHARS);
  const promptId = str(input.prompt_id, MAX_ID_CHARS);
  if (input.served_id !== undefined && servedId === undefined) return failure('served_id must be a nonempty item id');
  if (servedId === undefined && promptId === undefined) return failure('served_id is required for op: mark_processed; prompt_id is accepted for compatibility');
  if (servedId !== undefined && input.prompt_id !== undefined) return failure('provide served_id or prompt_id, not both');
  return acknowledgePrompt(db, scope, run.runId, servedId === undefined ? { promptId: promptId! } : { servedId }, ctx.now);
}
