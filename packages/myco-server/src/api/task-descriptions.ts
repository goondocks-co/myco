import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { readTaskDescriptions, readTaskNames, startableByHand } from '../read/task-descriptions.js';
import { readTaskStartPreview } from '../read/task-start.js';
import { memberAllowance } from './harness.js';
import { badRequest, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';

import type { ProjectSet } from '../read/scope.js';

/** Both task reads use the caller's resolved Projects. */
const taskRead = (read: (env: ServerEnv, set: ProjectSet) => unknown | Promise<unknown>) => async (env: ServerEnv, ctx: OwnerContext): Promise<Response> => {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  if (!isAdmin(ctx.member.role) && named.length === 0) return badRequest('Choose a project to read its task descriptions.');
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return ok({ tasks: await read(env, set) });
};

export const handleTaskDescriptions = taskRead(readTaskDescriptions);
export const handleTaskNames = taskRead(readTaskNames);

/**
 * `GET /api/tasks/start?project=&task=`: what starting a task by hand in one
 * Project would do now, and the caller's own day of runs of it, as the dispatch
 * would count it. Nothing is dispatched or recorded.
 */
export async function handleTaskStartPreview(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  const task = ctx.url.searchParams.get('task') ?? '';
  if (named.length !== 1 || task === '') return badRequest('Name one project and one task.');
  if (!startableByHand(task)) return badRequest('This task is not started by hand.');
  if (await resolveProjectSet(env.db, ctx.member, named) === null) return notFound();
  const [preview, allowance] = await Promise.all([
    readTaskStartPreview(env, named[0]!, task, ctx.now),
    memberAllowance(env, ctx, task),
  ]);
  return ok({ ...preview, allowance });
}
