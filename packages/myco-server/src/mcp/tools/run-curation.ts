import { completeCuration, curationAssignment, curationMaterial, curationOwned } from '../../core/spore-curation.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export async function handleRunCuration(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_curation');
  const assignment = curationAssignment(run.runContext);
  if (assignment === null) return failure('Not saved: curation decision; this run carries no curation assignment. Report the failure with myco_run op report.');
  try {
    if (input.op === 'material') return typeof input.id === 'string' ? await curationMaterial(ctx.env.db, ctx.projectId, run.runId, assignment, input.id) : failure('material requires id');
    const result = await completeCuration(ctx.env.db, ctx.projectId, run.runId, assignment, input.decision, input.reason, ctx.now, input.members);
    return typeof result === 'boolean' ? { completed: result } : result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('[myco_curation_owned]')) return curationOwned();
    if (error instanceof Error && error.message.includes('[myco_curation_changed]')) return { ...failure('Not saved: curation decision; assigned spores changed. Call myco_run op report with the failure; do not retry with newer revisions.'), code: 'material_changed' };
    throw error;
  }
}
