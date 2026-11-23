/**
 * `myco_agent` over the Deployment's run records, in the `{ok, op, data}`
 * envelope the member-side tool answers. A run answers its phases and reports;
 * the columns the harness alone reads never leave the read layer.
 */
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
import { RunBodyUnavailable, RunNotFound, listReportsWithBodies, runInstructionBody } from '../../db/runs/bodies.js';
import { decodeCursor } from '../../read/scope.js';
import { getRunDetail, listRunRefusals, listRuns } from '../../read/runs.js';
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
      const [instruction, reports, refusals] = await Promise.all([
        detail.run.instruction ?? runInstructionBody(env, scope, id),
        listReportsWithBodies(env, scope, id),
        listRunRefusals(db, scope, id),
      ]);
      return { ok: true, op, data: {
        run: snake({ ...detail.run, instruction: instruction === null ? null : redactSecrets(instruction) }), phases: detail.phases === null ? null : snake(detail.phases),
        reports: snake(reports.reports), reports_has_more: reports.hasMore,
        refusals: snake(refusals.refusals), refusals_has_more: refusals.hasMore,
        outcome_evidence: detail.outcomeEvidence === null ? null : snake(detail.outcomeEvidence),
      } };
    } catch (error) {
      if (error instanceof RunNotFound) return { ok: false, op, error: 'run not found' };
      if (error instanceof RunBodyUnavailable) return { ok: false, op, code: error.code, error: error.message, retryable: error.retryable };
      throw error;
    }
  }

  const cursor = str(input.cursor);
  if (cursor !== undefined && decodeCursor(cursor) === null) return { ...failure('Invalid cursor; call myco_agent with op runs and no cursor to start again.'), op };
  const page = await listRuns(db, scope, ctx.now, viewerOf(ctx), { cursor, task: str(input.task), agentId: str(input.agent_id), limit: typeof input.limit === 'number' ? input.limit : 50 });
  return { ok: true, op, data: { runs: snake(page.rows), cursor: page.cursor } };
}
