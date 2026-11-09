/** A session's related sessions, read from the catalog one page at a time. */
import type { ContentStore } from '../core/adapters.js';
import { clampLimit, page, type ReadScope } from '../read/scope.js';
import {
  session_activity_sessionEdges as sessionEdges,
  type session_activity_SessionActivityOptions as SessionActivityOptions,
} from '../read/catalog/session-activity.js';

export async function documentSessionActivity(env: ContentStore, scope: ReadScope, sessionId: string, opts: SessionActivityOptions) {
  const limit = clampLimit(opts.limit);
  return page(await sessionEdges(env.db, scope, sessionId, opts), limit, row => ({ createdAt: row.at, id: row.id }));
}
