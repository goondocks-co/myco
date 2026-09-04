/**
 * The harness routes: an owner's dispatch of one task, and the runtime probe —
 * the acceptance surface for a held runtime.
 *
 * A target without a runtime answers a refusal naming the capability, which
 * local dev and the parity harness treat as the expected answer. The dispatch
 * itself is `core/harness.ts`; this route decides only how it is asked for and
 * answered.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, DISPATCH_REFUSAL_MESSAGE, dispatchTask } from '../core/harness.js';
import { emit } from '../telemetry.js';
import { taskEntriesSince } from '../core/runs.js';
import { runTimeoutForTask, TASK_SCHEDULE } from '../core/task-catalogue.js';
import { scheduleFor, scheduleLeaves } from '../core/scheduled-tasks.js';
import { buildTaskInput } from '../core/task-inputs.js';
import { badRequest, ok, readJsonObject } from './scope.js';

const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

/** Dispatch one task to the harness runtime for a Project this Deployment holds. */
export async function handleHarnessDispatch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.harnessLaunch === undefined) {
    return Response.json({ error: 'harness_unavailable', message: DISPATCH_REFUSAL_MESSAGE.harness_unavailable }, { status: 409 });
  }
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const task = typeof body.task === 'string' && body.task.length > 0 && body.task.length <= 128 ? body.task : null;
  const projectId = typeof body.projectId === 'string' && PROJECT_ID_SHAPE.test(body.projectId) ? body.projectId : null;
  if (task === null || projectId === null) return badRequest('dispatch requires task and projectId');
  // The caller's bound, else the task's own budget, else the flat default.
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 3600
    ? body.timeoutSeconds
    : runTimeoutForTask(task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  const dryRun = body.dryRun === true;
  const fresh = body.fresh === true;

  // A task whose prompt the server builds is compared against the artifact the
  // Project already holds. Equal means the ask is answered with an outcome and
  // no run row at all — reads only, nothing spent — so it is decided ahead of
  // the day's ceiling: a person asking about a still Project is told it is
  // still, rather than told they have used up a run they never spent.
  const built = await buildTaskInput(env, task, projectId, ctx.now, { fresh });
  if (built !== null && built.unchanged) {
    emit({ kind: 'harness_unchanged', task, projectId, actor: ctx.member.id });
    return ok({ outcome: 'unchanged' });
  }
  // A person's ask bypasses the clock's interval, never its per-day ceiling: the
  // cap is the day's spend, whoever asks. The ceiling is the declared block under
  // the owner's own override, so a Deployment that lifts the cap for a day —
  // after a run that spent its money and produced nothing — is answered by the
  // number it set rather than the one shipped.
  const declared = TASK_SCHEDULE[task];
  const ceiling = declared === null || declared === undefined
    ? undefined
    : scheduleFor(task, declared, (await scheduleLeaves(env)).overrides).maxRunsPerDay;
  if (ceiling !== undefined && (await taskEntriesSince(env.db, { projectId }, task, ctx.now - 86_400_000)) >= ceiling) {
    return Response.json({ error: 'max_runs_per_day', message: `this task has run its ${ceiling} for the day` }, { status: 409 });
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

export async function handleHarnessProbe(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.harnessProbe === undefined) {
    return Response.json({ error: 'harness_unavailable', message: DISPATCH_REFUSAL_MESSAGE.harness_unavailable }, { status: 409 });
  }
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 600 ? body.timeoutSeconds : 120;
  // One well-known runtime by default, reused: a fresh name per call would
  // strand a warm container per probe until its idle window ends, and the
  // fleet is finite. A NAMED runtime is probed in place — the window into a
  // dispatched run's live state.
  const runId = typeof body.runId === 'string' && body.runId.length > 0 && body.runId.length <= 128 ? body.runId : 'probe';
  const answer = await env.harnessProbe(runId, timeoutSeconds);
  emit({ kind: 'harness_probe', runId, actor: ctx.member.id });
  return ok({ runId, timeoutSeconds, ...answer });
}
