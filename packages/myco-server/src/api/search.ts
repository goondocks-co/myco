import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { type SearchOptions } from '@goondocks/myco-shared/search-types';
import { searchAcross, searchDeployment } from '../core/search.js';
import { SearchRefused } from '../core/search-query.js';
import { badRequest, notFound, ok, projectSetParam, resolveProjectScope, resolveProjectSet } from './scope.js';

/** The search options a query string names, shared by a Project's search and the search across Projects. */
function searchOptions(searchParams: URLSearchParams): SearchOptions | Response {
  if (searchParams.has('language')) return badRequest('language filtering belongs to retired Canopy entries');
  const options: SearchOptions = { query: searchParams.get('q') ?? '' };
  for (const key of ['type', 'mode', 'status', 'session_id', 'observation_type', 'release_state', 'release_confidence', 'order', 'agent', 'branch', 'match'] as const) {
    if (searchParams.has(key)) options[key] = searchParams.get(key)!;
  }
  if (searchParams.has('cursor')) options.cursor = searchParams.get('cursor')!;
  for (const key of ['limit', 'since', 'until'] as const) if (searchParams.has(key)) options[key] = Number(searchParams.get(key));
  return options;
}

/**
 * A refused search names its code and the next request to make: 410 `cursor_expired` when the search's later pages
 * expired, 400 otherwise.
 */
async function answer(search: () => Promise<unknown>): Promise<Response> {
  try { return ok(await search()); }
  catch (error) {
    if (!(error instanceof SearchRefused)) throw error;
    if (error.code === 'cursor_expired') return Response.json({ error: 'cursor_expired', reasonCode: 'cursor_expired', reason: error.message }, { status: 410 });
    return Response.json({ error: 'bad_request', reasonCode: error.code, reason: error.message }, { status: 400 });
  }
}

export async function handleProjectSearch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const options = searchOptions(ctx.url.searchParams);
  if (options instanceof Response) return options;
  return answer(() => searchDeployment(env, scope, options, `member:${ctx.member.id}`, ctx.now));
}

/**
 * `GET /api/search`: word search across Projects, with a Project's search filters and a repeatable `project=`.
 * Naming none covers every Project that accepts capture; a named id that is not a Project answers 404, and more than
 * a read may name answers 400. Each hit carries its `projectId`.
 */
export async function handleSearchAcross(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const named = projectSetParam(ctx.url);
  if (named instanceof Response) return named;
  const options = searchOptions(ctx.url.searchParams);
  if (options instanceof Response) return options;
  const set = await resolveProjectSet(env.db, ctx.member, named);
  if (set === null) return notFound();
  return answer(() => searchAcross(env, set, options, `member:${ctx.member.id}`, ctx.now));
}
