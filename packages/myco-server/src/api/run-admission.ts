/** Shared admission for the live run principal and the retained runtime protocol. */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { HARNESS_MEMBER_ID } from '../core/harness.js';
import { staleAfter } from '../core/jobs-run.js';
import { getRun, isTerminalRunStatus, liveRunsOfCredential, runsOfCredential, type HeldRun, type RunRow, type RunCaller } from '../core/runs.js';
import { REPOSITORY_TASKS } from '@goondocks/myco-shared/repository';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { strictName } from '@goondocks/myco-shared/run-text';
import { decodeRunUpdate, endedAnswer, RUN_UPDATE_FIELDS } from './run-fields.js';

/** The retained protocol's capabilities; an undeclared route admits no run. */
export const CONTROL_CAPABILITIES: Readonly<Record<string, { tasks: readonly string[] | null; unleased: boolean }>> = {
  '/runs/claim': { tasks: null, unleased: false },
  '/runs/update': { tasks: null, unleased: false },
  '/runs/report': { tasks: null, unleased: false },
  '/runs/embedding-step': { tasks: ['embedding-reconcile'], unleased: false },
  '/runs/repository': { tasks: REPOSITORY_TASKS, unleased: true },
  '/runs/canopy-map': { tasks: [MAP_TASK], unleased: true },
};

export type RunControlAdmission = { held: true; run: HeldRun; settled?: Response } | { held: false };

/** Bind a retained operation to one dispatch, its Project, lifecycle and task capability. */
export async function admitRunControl(
  env: ServerEnv, auth: { memberId: string; tokenId: string }, projectId: string, path: string, body: string, now: number,
): Promise<RunControlAdmission> {
  if (auth.memberId !== HARNESS_MEMBER_ID || !Object.hasOwn(CONTROL_CAPABILITIES, path)) return { held: false };
  const rows = await runsOfCredential(env.db, auth.tokenId);
  if (rows.length !== 1) return { held: false };
  const run = rows[0]!;
  if (run.projectId !== projectId) return { held: false };
  let offer: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { held: false };
    offer = parsed as Record<string, unknown>;
  } catch { return { held: false }; }
  if ((path === '/runs/claim' ? offer.id : offer.runId) !== run.id) return { held: false };
  const capability = CONTROL_CAPABILITIES[path]!;
  const tasks = capability.tasks;
  if (tasks !== null && (run.task === null || !tasks?.includes(run.task))) return { held: false };
  if (isTerminalRunStatus(run.status)) {
    const settled = closeRetry(run, path, offer);
    return settled === null ? { held: false } : { held: true, run, settled };
  }
  const pending = run.status === 'pending' || (run.status === 'queued' && path === '/runs/claim');
  if (capability.unleased && run.leaseExpiresAt !== null) return { held: false };
  if (pending && path !== '/runs/claim' && path !== '/runs/update') return { held: false };
  if (!isLiveRun(pending ? { ...run, status: 'running' } : run, now)) return { held: false };
  if (path === '/runs/claim' && strictName(offer.task) !== null && offer.task !== run.task) return { held: false };
  return { held: true, run };
}

/** A closed run acknowledges its ending without admitting another write. */
function closeRetry(run: RunRow, path: string, offer: Record<string, unknown>): Response | null {
  if (path !== '/runs/update') return null;
  const update = offer.update;
  if (typeof update !== 'object' || update === null || Array.isArray(update) || !('status' in update)) return null;
  if (!isTerminalRunStatus(update.status) || Object.keys(update).some(key => !Object.hasOwn(RUN_UPDATE_FIELDS, key))) return null;
  const decoded = decodeRunUpdate(update as Record<string, unknown>, run.harness);
  return decoded === null ? null : endedAnswer(run.status, decoded.status);
}

/** The deadline of the dispatch's current attempt. */
export function runDeadline(run: RunRow): number {
  const attemptAt = run.resumedAt ?? run.startedAt;
  return attemptAt === null ? 0 : staleAfter(attemptAt, run.runContext);
}

/** The runtime's write authority, derived from pipeline admission. */
export function runtimeCaller(ctx: RouteContext): RunCaller {
  return { tokenId: ctx.tokenId, now: ctx.now, clock: ctx.clock, deadline: ctx.runDeadline ?? ctx.now };
}

/**
 * True while a run's runtime is taken to be alive: the row is `running`, this
 * instant is inside the run's own bound, and any lease on it is still held. One
 * predicate serves the run routes and the run principal on MCP.
 *
 * The two clocks answer different questions and both must hold. The bound is
 * the task's budget, which a run outruns when its harness hangs. The lease is
 * the worker's liveness, which lapses when the worker goes away — and once it
 * has, another worker may take the run, so the credential of the worker that
 * lost it must stop resolving before that happens rather than after.
 */
export function isLiveRun(run: RunRow, now: number): boolean {
  if (run.status !== 'running') return false;
  if (run.leaseExpiresAt !== null && run.leaseExpiresAt <= now) return false;
  return runDeadline(run) > now;
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
