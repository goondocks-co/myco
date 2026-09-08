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
import { getRun, liveRunsOfCredential, type HeldRun, type RunRow } from '../core/runs.js';

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

/** True while a run's runtime is taken to be alive: the row is `running` and this instant is inside its own bound. One predicate serves the run routes and the run principal on MCP. */
export function isLiveRun(run: RunRow, now: number): boolean {
  if (run.status !== 'running') return false;
  const attemptAt = run.resumedAt ?? run.startedAt;
  return attemptAt !== null && staleAfter(attemptAt, run.runContext) > now;
}

/** The live run of one of these tasks that this caller holds, or null. */
export async function heldRun(env: ServerEnv, ctx: RouteContext, runId: string, tasks: readonly string[]): Promise<RunRow | null> {
  if (ctx.memberId !== HARNESS_MEMBER_ID) return null;
  const run = await getRun(env.db, { projectId: ctx.projectId }, runId);
  if (run === null || run.dispatchedBy !== ctx.tokenId) return null;
  if (run.task === null || !tasks.includes(run.task) || !isLiveRun(run, ctx.now)) return null;
  return run;
}

/**
 * The one live run a harness credential holds, in whichever Project, or null.
 *
 * The dispatcher mints a fresh credential for every launch and the row names it
 * in `dispatched_by`, so a live run is found by the credential alone and the
 * request needs to name no run id. The store itself does not forbid two rows
 * naming one credential — the minting caller is what keeps them apart — so two
 * live rows is an ambiguity this answers as none held rather than by choosing.
 * A credential of any other member holds no run here, whatever `dispatched_by`
 * says — a person's own credential that claimed a run stays a member's.
 */
export async function heldRunOfCredential(env: ServerEnv, auth: { memberId: string; tokenId: string }, now: number): Promise<HeldRun | null> {
  if (auth.memberId !== HARNESS_MEMBER_ID) return null;
  const live = (await liveRunsOfCredential(env.db, auth.tokenId)).filter((run) => isLiveRun(run, now));
  return live.length === 1 ? live[0] : null;
}
