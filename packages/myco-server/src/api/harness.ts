/**
 * The harness dispatch route: an owner's ask for one task to be run.
 *
 * A dispatch of a worker-served task is answered by the queue: neither front
 * door runs a harness, so the ask lands a queued run whether or not a worker is
 * attached, and an operator reads the wait on the run rather than as a refusal
 * here. The three tasks that still ride the launch seam refuse without one,
 * which local dev and the parity harness treat as the expected answer. The
 * dispatch itself is `core/harness.ts`; this route decides only how it is asked
 * for and answered.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, DISPATCH_REFUSAL_MESSAGE, dispatchTask, RUNTIME_SERVED_TASKS } from '../core/harness.js';
import { emit } from '../telemetry.js';
import { runTimeoutForTask } from '../core/task-catalogue.js';
import { buildTaskInput } from '../core/task-inputs.js';
import { badRequest, ok, readJsonObject } from './scope.js';

const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** Dispatch one task to the harness runtime for a Project this Deployment holds. */
export async function handleHarnessDispatch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const task = typeof body.task === 'string' && body.task.length > 0 && body.task.length <= 128 ? body.task : null;
  const projectId = typeof body.projectId === 'string' && PROJECT_ID_SHAPE.test(body.projectId) ? body.projectId : null;
  if (task === null || projectId === null) return badRequest('dispatch requires task and projectId');
  // The caller's bound, else the task's own budget, else the flat default.
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 3600
    ? body.timeoutSeconds
    : runTimeoutForTask(task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  // A task the launch seam serves cannot be dispatched without one, and an
  // operator reads that as the Deployment lacking a capability rather than as a
  // bad ask. A worker-served task is never refused here: it queues.
  if (env.harnessLaunch === undefined && RUNTIME_SERVED_TASKS.includes(task)) {
    return Response.json({ error: 'harness_unavailable', message: DISPATCH_REFUSAL_MESSAGE.harness_unavailable }, { status: 409 });
  }
  const dryRun = body.dryRun === true;
  const fresh = body.fresh === true;

  // Unchanged input returns without dispatching a run.
  const built = await buildTaskInput(env, task, projectId, ctx.now, { fresh });
  if (built !== null && built.unchanged) {
    emit({ kind: 'harness_unchanged', task, projectId, actor: ctx.member.id });
    return ok({ outcome: 'unchanged' });
  }
  const input = built === null || built.unchanged
    ? {}
    : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
  const outcome = await dispatchTask(env, task, projectId, { serverUrl: ctx.url.origin, actor: ctx.member.id, timeoutSeconds, ...input, options: { dryRun, fresh } }, ctx.now);
  if (!outcome.dispatched) {
    return badRequest(outcome.refusal === 'unsupported_provider'
      ? `${DISPATCH_REFUSAL_MESSAGE.unsupported_provider}, and the configured provider is ${outcome.providerType ?? 'another'}`
      : DISPATCH_REFUSAL_MESSAGE[outcome.refusal]);
  }
  const { dispatched: _dispatched, ...answer } = outcome;
  return ok(answer);
}
