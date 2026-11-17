import { answerSporeCuration } from '../../core/spore-curation.js';
import { runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export async function handleRunCuration(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const principal = runOf(ctx, 'myco_run_curation');
  return answerSporeCuration(input, { db: ctx.env.db, projectId: ctx.projectId, runId: principal.runId,
    agentId: principal.agentId, runContext: principal.runContext, now: ctx.now });
}
