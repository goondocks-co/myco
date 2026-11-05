import { CURATION_REASON_CHARS, completeCuration, curationAssignment } from '../../core/spore-curation.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export async function handleRunCuration(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_curation');
  const assignment = curationAssignment(run.runContext);
  if (assignment === null) return failure('this run carries no curation assignment');
  if (input.decision !== 'keep' && input.decision !== 'resolved') return failure('decision is keep or resolved');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > CURATION_REASON_CHARS) return failure(`reason is nonempty text of at most ${CURATION_REASON_CHARS} characters`);
  try {
    return { completed: await completeCuration(ctx.env.db, ctx.projectId, run.runId, assignment, input.decision, input.reason.trim(), ctx.now) };
  } catch (error) {
    if (error instanceof Error && error.message.includes('[myco_curation_changed]')) return { ...failure('assigned spores changed; this decision was not recorded'), code: 'material_changed' };
    throw error;
  }
}
