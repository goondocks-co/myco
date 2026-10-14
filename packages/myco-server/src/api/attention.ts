/**
 * `GET /api/attention`: what an administrator should act on (Today's "Needs you").
 *
 * Admin only, by the route's declared authority: every item is about the Deployment's own operation, which only an
 * administrator can change.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, notFound, resolveProjectScope, ok } from './scope.js';
import { projectRepositoryNeeded } from '../read/repository-requirements.js';
import { readAttention } from '../core/attention.js';

export async function handleAttention(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const projectId = ctx.url.searchParams.get('project');
  if (projectId !== null) {
    if (ctx.url.searchParams.getAll('project').length !== 1) return badRequest('name one project');
    const scope = await resolveProjectScope(env.db, ctx.member, projectId);
    if (scope === null) return notFound();
    const requirement = await projectRepositoryNeeded(env, scope);
    return ok({ items: requirement === null ? [] : [{ kind: 'repository_missing', tone: 'warn', ...requirement }], unavailable: [] });
  }
  return ok(await readAttention(env, ctx.now));
}
