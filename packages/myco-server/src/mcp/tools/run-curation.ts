import { runRefusal, REPORT_NEXT } from '../../core/run-tool-contract.js';
import { completeCuration, curationAssignment, curationMaterial, curationOwned } from '../../core/spore-curation.js';
import { curationChangedReason, curationOwnedRefused } from '../../db/spores/curation-run.js';
import { runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export async function handleRunCuration(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_curation');
  const assignment = curationAssignment(run.runContext);
  if (assignment === null)
    return runRefusal({ what: 'curation decision', actual: 'this run carries no curation assignment', next: REPORT_NEXT });
  try {
    if (input.op === 'material')
      return typeof input.id === 'string'
        ? await curationMaterial(ctx.env.db, ctx.projectId, run.runId, assignment, input.id)
        : runRefusal({
            what: 'curation material read',
            read: true,
            actual: 'id is missing or not text',
            next: { tool: 'myco_run_curation', op: 'material' },
            repair: 'Supply a seeded or searched id.',
          });
    const result = await completeCuration(
      ctx.env.db,
      ctx.projectId,
      run.runId,
      assignment,
      input.decision,
      input.reason,
      ctx.now,
      input.members,
    );
    if (result === false)
      return runRefusal({
        what: 'curation decision',
        actual: 'completion stored 0 decisions; expected 1 open assignment',
        next: REPORT_NEXT,
      });
    return result === true ? { completed: true } : result;
  } catch (error) {
    if (curationOwnedRefused(error)) return curationOwned(input.id);
    const changed = curationChangedReason(error);
    if (changed !== null)
      return {
        ...runRefusal({
          what: 'curation decision',
          actual: `assigned spores changed: ${changed}; nothing was saved; do not retry with newer revisions`,
          next: REPORT_NEXT,
        }),
        code: 'material_changed',
      };
    throw error;
  }
}
