/**
 * `myco_agent` over the Deployment's run records, in the `{ok, op, data}`
 * envelope the member-side tool answers. A run answers its phases and reports;
 * the columns the harness alone reads never leave the read layer.
 */
import { listReports } from '../../core/runs.js';
import { getRunDetail, listRuns } from '../../read/runs.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export async function handleAgent(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const op = input.op ?? 'runs';
  const scope = await scopeOf(ctx, input);
  if (scope === null) return { ...failure('Project not found'), op };
  const { db } = ctx.env;

  if (op === 'run') {
    const id = str(input.id);
    if (id === undefined) return { ok: false, op, error: 'id is required for op: run' };
    const detail = await getRunDetail(db, scope, id);
    if (detail === null) return { ok: false, op, error: 'run not found' };
    return { ok: true, op, data: { run: snake(detail.run), phases: detail.phases === null ? null : snake(detail.phases), reports: snake(await listReports(db, scope, id)) } };
  }

  const page = await listRuns(db, scope, { task: str(input.task), agentId: str(input.agent_id), limit: typeof input.limit === 'number' ? input.limit : 50 });
  return { ok: true, op, data: { runs: snake(page.rows), cursor: page.cursor } };
}
