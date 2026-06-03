import { getActivityFeed } from '@myco/db/queries/feed.js';
import { FEED_DEFAULT_LIMIT } from '@myco/constants.js';
import { projectScopeFromRequestContext } from '@myco/grove/request-context.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetFeed(req: RouteRequest): Promise<RouteResponse> {
  const limit = Number(req.query.limit) || FEED_DEFAULT_LIMIT;
  // Project scope MUST be applied: sessions/agent_runs/spores all carry
  // project_id post-Grove; an unscoped read leaks rows across projects in
  // the same Grove DB. `projectScopeFromRequestContext` throws on an
  // absent context — that's intentional, every API request to a Grove DB
  // must arrive with a resolved project context.
  const scope = projectScopeFromRequestContext(req.requestContext);
  const feed = getActivityFeed(scope, limit);
  return { body: feed };
}
