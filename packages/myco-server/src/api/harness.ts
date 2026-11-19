/**
 * The harness dispatch route: a member's ask for one task to be run.
 *
 * A dispatch of a worker-served task is answered by the queue: neither front
 * door runs a harness, so the ask lands a queued run whether or not a worker is
 * attached, and an operator reads the wait on the run rather than as a refusal
 * here. The two tasks that still ride the launch seam refuse without one,
 * which local dev and the parity harness treat as the expected answer. The
 * dispatch itself is `core/harness.ts`; this route decides only how it is asked
 * for and answered.
 */
import type { ServerEnv } from '../core/adapters.js';
import { MAX_WORKER_RUN_SECONDS } from '@goondocks/myco-shared/harness-health';
import type { OwnerContext } from '../context.js';
import {
  CeilingReached,
  DISPATCH_REFUSAL_MESSAGE,
  DispatchAdmissionRefused,
  prepareDispatch,
  dispatchPrepared,
  type DispatchRefusal,
} from '../core/harness.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS } from '../core/run-deadline.js';
import { RUNTIME_SERVED_TASKS } from '../core/worker-selection.js';
import { type ActorCeiling } from '../core/runs.js';
import { discoverCurationPreview, InvalidCurationContinuation } from '../core/curation-preview.js';
import { deploymentTaskCeilingWindow } from '../db/runs/claim.js';
import { memberRunsPerDay } from '../core/schedule-rules.js';
import { isAdmin } from '../auth/roles.js';
import { curationDailyLimit } from '../core/settings.js';
import { emit } from '../telemetry.js';
import { CURATION_TASK, runTimeoutForTask } from '../core/task-catalogue.js';
import { buildTaskInput } from '../core/task-inputs.js';
import { badRequest, ok, readJsonObject } from './scope.js';

/** The project identifier admitted by a dispatch request. */
export const isDispatchProjectId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
const DAY_MS = 86_400_000;

/**
 * The ceiling on a member who is not an admin: `memberRunsPerDay` runs of the task in a rolling day, across every
 * Project, counted by who started them. Curation previews have a separate per-admin, per-Project allowance.
 */
async function memberCeiling(env: ServerEnv, ctx: OwnerContext, task: string): Promise<ActorCeiling | undefined> {
  if (isAdmin(ctx.member.role)) return undefined;
  return { actor: ctx.member.id, task, perDay: await memberRunsPerDay(env, task), sinceMs: ctx.now - DAY_MS };
}

/** A member's day of runs of a task: how many they may start, how many they have, and when the oldest leaves the window once it is full. */
interface MemberAllowance { perDay: number; used: number; resetsAt: number | null }

async function allowanceOf(env: ServerEnv, ceiling: ActorCeiling): Promise<MemberAllowance> {
  const window = await deploymentTaskCeilingWindow(env.db, ceiling.task, ceiling.sinceMs, ceiling.actor, ceiling.perDay);
  return { perDay: ceiling.perDay, used: window.used, resetsAt: window.pivotAt === null ? null : window.pivotAt + DAY_MS };
}

/** The caller's day of runs of `task`, as the dispatch would count it; null for an uncapped task. */
export async function memberAllowance(env: ServerEnv, ctx: OwnerContext, task: string): Promise<MemberAllowance | null> {
  const ceiling = await memberCeiling(env, ctx, task);
  return ceiling === undefined ? null : allowanceOf(env, ceiling);
}

/** A member's day of runs of the task is spent: 429 naming the ceiling and when the oldest run in it leaves the window. */
async function dailyLimit(env: ServerEnv, ceiling: ActorCeiling, now: number): Promise<Response> {
  if (ceiling.task === CURATION_TASK) return Response.json({ error: 'daily_limit', task: ceiling.task, perDay: ceiling.perDay, resetsAt: null,
    message: `The preview allowance of ${ceiling.perDay} runs for this administrator and Project in 24 hours is spent. Try again after an earlier preview leaves that window.` }, { status: 429 });
  const { resetsAt } = await allowanceOf(env, ceiling);
  return Response.json({ error: 'daily_limit', task: ceiling.task, perDay: ceiling.perDay, resetsAt }, {
    status: 429,
    ...(resetsAt === null ? {} : { headers: { 'retry-after': String(Math.max(1, Math.ceil((resetsAt - now) / 1000))) } }),
  });
}

/** Dispatch one task to the harness runtime for a Project this Deployment holds. */
export async function handleHarnessDispatch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const task = typeof body.task === 'string' && body.task.length > 0 && body.task.length <= 128 ? body.task : null;
  const projectId = isDispatchProjectId(body.projectId) ? body.projectId : null;
  if (task === null || projectId === null) return badRequest('dispatch requires task and projectId');
  // An admin's bound, else the task's own budget, else the flat default. A member runs a task on its own budget.
  const timeoutSeconds = isAdmin(ctx.member.role) && typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= MAX_WORKER_RUN_SECONDS
    ? body.timeoutSeconds
    : runTimeoutForTask(task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  // A switch that decides what a run spends is a boolean or absent; anything else is refused rather than read as off.
  for (const key of ['dryRun', 'fresh'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return badRequest(`${key} must be true or false`);
  }
  // A task the launch seam serves cannot be dispatched without one, and an
  // operator reads that as the Deployment lacking a capability rather than as a
  // bad ask. A worker-served task is never refused here: it queues.
  if (env.harnessLaunch === undefined && RUNTIME_SERVED_TASKS.includes(task)) {
    return dispatchRefusal('harness_unavailable', 409);
  }
  const dryRun = body.dryRun === true;
  const fresh = body.fresh === true;
  if (task === CURATION_TASK && !isAdmin(ctx.member.role)) return Response.json({ error: dryRun ? 'curation_preview_needs_admin' : 'curation_hand_start_needs_admin',
    message: dryRun ? 'Only a Deployment administrator may preview curation.' : 'Members cannot start curation by hand; scheduled curation is pulled by runners when the Project enables it.' }, { status: 403 });
  const params = task === CURATION_TASK && typeof body.group === 'string' ? { group: body.group } : undefined;
  // A fresh run is one over input that has not moved; only an admin spends on that.
  if (fresh && !isAdmin(ctx.member.role)) return Response.json({ error: 'fresh_needs_admin' }, { status: 403 });
  const prepared = await prepareDispatch(env, task, projectId, { curationPreview: dryRun && isAdmin(ctx.member.role) });
  if (!prepared.ok) return refuseAdmission(prepared.refusal, prepared.capability);
  if (task === CURATION_TASK && !dryRun) return badRequest('curate-spores hand starts require an administrator and dryRun:true; normal groups are pulled by runners');
  const ceiling: ActorCeiling | undefined = task === CURATION_TASK
    ? { actor: ctx.member.id, task, projectId, perDay: await curationDailyLimit(env.db, projectId), sinceMs: ctx.now - DAY_MS }
    : await memberCeiling(env, ctx, task);
  let preview;
  try { preview = task === CURATION_TASK && dryRun ? await discoverCurationPreview(env, { projectId, now: ctx.now, group: params?.group, continuation: body.continuation }) : null; }
  catch (error) {
    if (!(error instanceof InvalidCurationContinuation)) throw error;
    return Response.json({ error: 'invalid_curation_continuation', message: error.message }, { status: 400 });
  }
  // Unchanged input returns without dispatching a run.
  const built = preview === null ? await buildTaskInput(env, task, projectId, ctx.now, { fresh, params, dryRun })
    : preview.input === null ? null : { unchanged: false as const, input: preview.input };
  if (preview !== null && built === null) return ok({ outcome: preview.outcome, continuation: preview.continuation,
    message: preview.outcome === 'vectors_pending' ? 'Every seed visited is waiting for vector data. No preview run was started.'
      : 'No qualifying curation group was found within the page budget; no preview run was started.' });
  if (built !== null && built.unchanged) {
    emit({ kind: 'harness_unchanged', task, projectId, actor: ctx.member.id });
    return ok({ outcome: 'unchanged' });
  }
  const input = built === null || built.unchanged
    ? {}
    : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts, context: built.input.context };
  try {
    const dispatched = await dispatchPrepared(env, prepared.prepared, { serverUrl: ctx.url.origin, actor: ctx.member.id, timeoutSeconds, ...input, params, options: { dryRun, fresh } }, ctx.now, { ceiling, actor: { memberId: ctx.member.id, authority: isAdmin(ctx.member.role) ? 'admin' : 'member' } });
    return ok({ ...dispatched, ...(preview === null ? {} : { outcome: preview.outcome, continuation: preview.continuation }) });
  } catch (error) {
    if (error instanceof CeilingReached && ceiling !== undefined) return dailyLimit(env, ceiling, ctx.now);
    if (error instanceof DispatchAdmissionRefused) return refuseAdmission(error.refusal, error.capability);
    throw error;
  }
}

/** Admission refusals retain their status and capability at preparation and commit. */
function refuseAdmission(refusal: DispatchRefusal, capability?: string): Response {
  return refusal === 'capability_off'
    ? Response.json({ error: refusal, capability, message: DISPATCH_REFUSAL_MESSAGE.capability_off }, { status: 409 })
    : dispatchRefusal(refusal);
}

/** Named dispatch refusals keep their code and words across admission and execution. */
export function dispatchRefusal(error: DispatchRefusal, status = 400): Response {
  return Response.json({ error, message: DISPATCH_REFUSAL_MESSAGE[error] }, { status });
}
