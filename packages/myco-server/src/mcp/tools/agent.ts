/**
 * `myco_agent` over the Deployment's run records, in the `{ok, op, data}`
 * envelope the member-side tool answers. A run answers its phases and reports;
 * the columns the harness alone reads never leave the read layer.
 */
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import { RunBodyUnavailable, RunNotFound, listReportsWithBodies, runInstructionBody } from '../../db/runs/bodies.js';
import { getRunDetail, listRuns } from '../../read/runs.js';
import { failure, scopeOf, viewerOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export async function handleAgent(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const op = input.op ?? 'runs';
  const scope = await scopeOf(ctx, input);
  if (scope === null) return { ...failure('Project not found'), op };
  const { db } = ctx.env;
  const env = ctx.env;

  if (op === 'run') {
    const id = str(input.id);
    if (id === undefined) return { ok: false, op, error: 'id is required for op: run' };
    const detail = await getRunDetail(db, scope, id, ctx.now, viewerOf(ctx));
    if (detail === null) return { ok: false, op, error: 'run not found' };
    try {
      const instruction = detail.run.instruction ?? await runInstructionBody(env, scope, id);
      const reports = await listReportsWithBodies(env, scope, id);
      return { ok: true, op, data: {
        run: snake({ ...detail.run, instruction: instruction === null ? null : redactSecrets(instruction) }), phases: detail.phases === null ? null : snake(detail.phases),
        reports: snake(reports.reports), reports_has_more: reports.hasMore,
        outcome_evidence: detail.outcomeEvidence === null ? null : snake(detail.outcomeEvidence),
      } };
    } catch (error) {
      if (error instanceof RunNotFound) return { ok: false, op, error: 'run not found' };
      if (error instanceof RunBodyUnavailable) return { ok: false, op, error: error.code, message: error.message, retryable: error.retryable };
      throw error;
    }
  }

  const page = await listRuns(db, scope, ctx.now, viewerOf(ctx), { task: str(input.task), agentId: str(input.agent_id), limit: typeof input.limit === 'number' ? input.limit : 50 });
  return { ok: true, op, data: { runs: snake(page.rows), cursor: page.cursor } };
}
