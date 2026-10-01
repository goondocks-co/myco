import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { readCanopyMap } from '../read/canopy.js';
import { notFound, ok, resolveProjectScope } from './scope.js';

export async function handleProjectMap(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  return scope === null ? notFound() : ok({ map: await readCanopyMap(env.db, scope) });
}
