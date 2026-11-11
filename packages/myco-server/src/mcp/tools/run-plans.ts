/**
 * `myco_run_plans`: a plan curation run's one write, a decision for one assigned plan (`resolveAssignedPlan`). The
 * plan, the revision the decision binds and the evidence it may cite are the run's own assignment, read off its row.
 */
import { PLAN_CURATION_TOOL, resolveAssignedPlan } from '../../core/plan-curation.js';
import { runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

export async function handleRunPlans(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, PLAN_CURATION_TOOL);
  return resolveAssignedPlan(ctx.env.db, { projectId: ctx.projectId }, run, {
    planId: input.plan_id, decision: input.decision, note: input.note, evidence: input.evidence, supersededBy: input.superseded_by,
  }, ctx.now);
}
