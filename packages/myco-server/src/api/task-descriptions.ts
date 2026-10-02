import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { isAdmin } from '../auth/roles.js';
import { readTaskDescriptions } from '../read/task-descriptions.js';
import { badRequest, notFound, ok, projectSetParam, resolveProjectSet } from './scope.js';

/** Admins may inspect all definitions; members inspect definitions for the Projects they may read. */
export async function handleTaskDescriptions(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  if (!isAdmin(ctx.member.role) && named.length === 0) return badRequest('Choose a project to read its task descriptions.');
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return ok({ tasks: await readTaskDescriptions(env) });
}
