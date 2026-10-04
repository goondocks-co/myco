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
import { CeilingReached, DEFAULT_DISPATCH_TIMEOUT_SECONDS, DISPATCH_REFUSAL_MESSAGE, dispatchTask, RUNTIME_SERVED_TASKS } from '../core/harness.js';
import { deploymentTaskCeilingWindow, type ActorCeiling } from '../core/runs.js';
import { memberRunsPerDay } from '../core/scheduled-tasks.js';
import { isAdmin } from '../auth/roles.js';
import { emit } from '../telemetry.js';
import { runTimeoutForTask } from '../core/task-catalogue.js';
import { buildTaskInput } from '../core/task-inputs.js';
import { badRequest, ok, readJsonObject } from './scope.js';

const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;
const DAY_MS = 86_400_000;

/**
 * The ceiling on a member who is not an admin: `memberRunsPerDay` runs of the task in a rolling day, across every
 * Project, counted by who started them. An admin starts runs uncapped.
 */
async function memberCeiling(env: ServerEnv, ctx: OwnerContext, task: string): Promise<ActorCeiling | undefined> {
  if (isAdmin(ctx.member.role)) return undefined;
  return { actor: ctx.member.id, task, perDay: await memberRunsPerDay(env, task), sinceMs: ctx.now - DAY_MS };
}

/** A member's day of runs of a task: how many they may start, how many they have, and when the oldest leaves the window once it is full. */
export interface MemberAllowance { perDay: number; used: number; resetsAt: number | null }

async function allowanceOf(env: ServerEnv, ceiling: ActorCeiling): Promise<MemberAllowance> {
  const window = await deploymentTaskCeilingWindow(env.db, ceiling.task, ceiling.sinceMs, ceiling.actor, ceiling.perDay);
  return { perDay: ceiling.perDay, used: window.used, resetsAt: window.pivotAt === null ? null : window.pivotAt + DAY_MS };
}

/** The caller's day of runs of `task`, as the dispatch would count it; null for an admin, who starts runs uncapped. */
export async function memberAllowance(env: ServerEnv, ctx: OwnerContext, task: string): Promise<MemberAllowance | null> {
  const ceiling = await memberCeiling(env, ctx, task);
  return ceiling === undefined ? null : allowanceOf(env, ceiling);
}

/** A member's day of runs of the task is spent: 429 naming the ceiling and when the oldest run in it leaves the window. */
async function dailyLimit(env: ServerEnv, ceiling: ActorCeiling, now: number): Promise<Response> {
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
  const projectId = typeof body.projectId === 'string' && PROJECT_ID_SHAPE.test(body.projectId) ? body.projectId : null;
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
    return Response.json({ error: 'harness_unavailable', message: DISPATCH_REFUSAL_MESSAGE.harness_unavailable }, { status: 409 });
  }
  const dryRun = body.dryRun === true;
  const fresh = body.fresh === true;
  // A fresh run is one over input that has not moved; only an admin spends on that.
  if (fresh && !isAdmin(ctx.member.role)) return Response.json({ error: 'fresh_needs_admin' }, { status: 403 });
  const ceiling = await memberCeiling(env, ctx, task);

  // Unchanged input returns without dispatching a run.
  const built = await buildTaskInput(env, task, projectId, ctx.now, { fresh });
  if (built !== null && built.unchanged) {
    emit({ kind: 'harness_unchanged', task, projectId, actor: ctx.member.id });
    return ok({ outcome: 'unchanged' });
  }
  const input = built === null || built.unchanged
    ? {}
    : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
  let outcome;
  try {
    outcome = await dispatchTask(env, task, projectId, { serverUrl: ctx.url.origin, actor: ctx.member.id, timeoutSeconds, ...input, options: { dryRun, fresh } }, ctx.now, ceiling === undefined ? {} : { ceiling });
  } catch (error) {
    if (error instanceof CeilingReached && ceiling !== undefined) return dailyLimit(env, ceiling, ctx.now);
    throw error;
  }
  if (!outcome.dispatched) {
    if (outcome.refusal === 'capability_off') {
      return Response.json({ error: 'capability_off', capability: outcome.capability, message: DISPATCH_REFUSAL_MESSAGE.capability_off }, { status: 409 });
    }
    return badRequest(DISPATCH_REFUSAL_MESSAGE[outcome.refusal]);
  }
  const { dispatched: _dispatched, ...answer } = outcome;
  return ok(answer);
}
