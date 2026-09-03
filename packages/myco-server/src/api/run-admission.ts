/**
 * Which run a caller on the run-control surface holds.
 *
 * A dispatch mints a credential scoped to one run, and the routes a task's tool
 * surface is served over are where that scope is enforced. The row is the
 * server's own record of the dispatch (`recordDispatch`), so its task, context
 * and attribution are the dispatcher's word, never the runtime's. A run is live
 * only inside its own bound: a container that died leaves its row `running`, and
 * its credential must not keep serving past the window everything else reasons
 * about.
 *
 * Every condition collapses to one answer, `held: false`: which one failed tells
 * a caller nothing it may act on, and naming it would tell a stranger which run
 * ids exist. It is a settled answer inside `persisted: true` — the request is
 * well-formed and acted on — not a refusal of the request's shape.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { HARNESS_MEMBER_ID } from '../core/harness.js';
import { staleAfter } from '../core/jobs-run.js';
import { getRun, type RunRow } from '../core/runs.js';

/** The session a run's recorded context names, or null when it names none. */
export function sessionNamedByRun(run: RunRow): string | null {
  if (run.runContext === null) return null;
  try {
    const parsed: unknown = JSON.parse(run.runContext);
    const value = typeof parsed === 'object' && parsed !== null ? (parsed as { session_id?: unknown }).session_id : undefined;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The live run of one of these tasks that this caller holds, or null. */
export async function heldRun(env: ServerEnv, ctx: RouteContext, runId: string, tasks: readonly string[]): Promise<RunRow | null> {
  if (ctx.memberId !== HARNESS_MEMBER_ID) return null;
  const run = await getRun(env.db, { projectId: ctx.projectId }, runId);
  if (run === null || run.dispatchedBy !== ctx.tokenId) return null;
  if (run.task === null || !tasks.includes(run.task) || run.status !== 'running') return null;
  const attemptAt = run.resumedAt ?? run.startedAt;
  if (attemptAt === null || staleAfter(attemptAt, run.runContext) <= ctx.now) return null;
  return run;
}
