/**
 * Activity feed query — unified timeline across sessions, agent_runs, and spores.
 *
 * Uses UNION ALL to merge per-table subqueries, then a final ORDER BY + LIMIT
 * to produce a cross-table timeline ordered by timestamp descending.
 *
 * Every branch filters on `project_id` via the supplied `ProjectScope`.
 * Post-Grove, all three tables hold rows from multiple projects in the
 * same Grove DB; an unfiltered read leaks data across project boundaries.
 * Callers must pass the scope from `projectScopeFromRequestContext` (or
 * explicitly opt into `ALL_PROJECTS_SCOPE` for cross-project admin views).
 */

import { getDatabase, type Database } from '@myco/db/client.js';
import { FEED_DEFAULT_LIMIT } from '@myco/constants.js';
import { projectScopeClause, type ProjectScope } from './project-scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the unified activity feed. */
export interface FeedEntry {
  type: 'session' | 'agent_run' | 'spore';
  id: string;
  summary: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the most recent activity across sessions, agent runs, and spores
 * within `scope`, merged into a single timeline sorted by timestamp descending.
 *
 * Each branch contributes up to `limit` candidates; the final result is
 * also capped at `limit`.
 *
 * SQLite does not support per-branch ORDER BY + LIMIT inside UNION ALL
 * parenthesized subqueries the way PostgreSQL does. Instead, each branch
 * is wrapped as a subquery (SELECT ... ORDER BY ... LIMIT ?) to achieve
 * the same effect.
 */
export function getActivityFeed(
  scope: ProjectScope,
  limit: number = FEED_DEFAULT_LIMIT,
  db: Database = getDatabase(),
): FeedEntry[] {
  const clause = projectScopeClause(scope);

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'session' as type, id, COALESCE(title, 'Session ' || substr(id, 1, 8)) as summary,
              COALESCE(ended_at, started_at) as timestamp
       FROM sessions WHERE 1 = 1${clause.sql} ORDER BY started_at DESC LIMIT ?
    )

    UNION ALL

    SELECT * FROM (
      SELECT 'agent_run' as type, id, task || ' — ' || status as summary,
              COALESCE(completed_at, started_at) as timestamp
       FROM agent_runs WHERE 1 = 1${clause.sql}
       ORDER BY COALESCE(resumed_at, started_at) DESC LIMIT ?
    )

    UNION ALL

    SELECT * FROM (
      SELECT 'spore' as type, id, observation_type || ': ' || substr(content, 1, 80) as summary,
              created_at as timestamp
       FROM spores WHERE status = 'active'${clause.sql} ORDER BY created_at DESC LIMIT ?
    )

    ORDER BY timestamp DESC LIMIT ?
  `).all(
    ...clause.params, limit,
    ...clause.params, limit,
    ...clause.params, limit,
    limit,
  ) as FeedEntry[];

  return rows;
}
