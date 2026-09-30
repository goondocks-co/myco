import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { InvalidSearch, searchAcross, type SearchOptions } from '../read/search.js';
import { searchDeployment } from '../core/search.js';
import { badRequest, notFound, ok, projectSetParam, resolveProjectScope, resolveProjectSet } from './scope.js';

/** The search options a query string names, shared by a Project's search and the search across Projects. */
function searchOptions(q: URLSearchParams): SearchOptions | Response {
  if (q.has('language')) return badRequest('language filtering belongs to retired Canopy entries');
  const options: SearchOptions = { query: q.get('q') ?? '' };
  for (const key of ['type', 'mode', 'status', 'session_id', 'observation_type', 'release_state', 'release_confidence'] as const) {
    if (q.has(key)) options[key] = q.get(key)!;
  }
  if (!q.has('type') && q.has('namespace')) options.type = q.get('namespace')!;
  for (const key of ['limit', 'since', 'until'] as const) if (q.has(key)) options[key] = Number(q.get(key));
  return options;
}

async function answer(search: () => Promise<unknown>): Promise<Response> {
  try { return ok(await search()); }
  catch (error) {
    if (error instanceof InvalidSearch) return badRequest(error.message);
    throw error;
  }
}

export async function handleProjectSearch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const options = searchOptions(ctx.url.searchParams);
  if (options instanceof Response) return options;
  return answer(() => searchDeployment(env, scope, options));
}

/**
 * `GET /api/search`: full-text search across Projects, with a Project's search filters and a repeatable `project=`.
 * Naming none covers every Project that accepts capture; a named id that is not a Project answers 404, and more than
 * a read may name answers 400. Each result carries its `projectId`.
 */
export async function handleSearchAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  const options = searchOptions(ctx.url.searchParams);
  if (options instanceof Response) return options;
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return answer(() => searchAcross(env.db, set, options));
}
