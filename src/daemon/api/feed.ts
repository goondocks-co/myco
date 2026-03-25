import { getActivityFeed } from '@myco/db/queries/feed.js';
import { FEED_DEFAULT_LIMIT } from '@myco/constants.js';
import type { RouteRequest, RouteResponse } from '../router.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetFeed(req: RouteRequest): Promise<RouteResponse> {
  const limit = Number(req.query.limit) || FEED_DEFAULT_LIMIT;
  const feed = getActivityFeed(limit);
  return { body: feed };
}
