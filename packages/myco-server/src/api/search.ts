import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { InvalidSearch, searchProject, type SearchOptions } from '../read/search.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';

export async function handleProjectSearch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const q = ctx.url.searchParams;
  if (q.has('language')) return badRequest('language filtering belongs to retired Canopy entries');
  const options: SearchOptions = { query: q.get('q') ?? '' };
  for (const key of ['type', 'mode', 'status', 'session_id', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (q.has(key)) options[key] = q.get(key)!;
  }
  if (!q.has('type') && q.has('namespace')) options.type = q.get('namespace')!;
  for (const key of ['limit', 'since', 'until'] as const) if (q.has(key)) options[key] = Number(q.get(key));
  try { return ok(await searchProject(env.db, scope, options)); }
  catch (error) {
    if (error instanceof InvalidSearch) return badRequest(error.message);
    throw error;
  }
}
