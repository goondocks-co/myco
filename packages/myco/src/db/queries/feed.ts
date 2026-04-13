/**
 * Activity feed query — unified timeline across sessions, agent_runs, and spores.
 *
 * Uses UNION ALL to merge per-table subqueries, then a final ORDER BY + LIMIT
 * to produce a cross-table timeline ordered by timestamp descending.
 *
 * All functions obtain the SQLite instance internally via `getDatabase()`.
 * Queries use positional `?` placeholders throughout (better-sqlite3).
 */

import { getDatabase } from '@myco/db/client.js';
import { FEED_DEFAULT_LIMIT } from '@myco/constants.js';

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
 * Return the most recent activity across sessions, agent runs, and spores,
 * merged into a single timeline sorted by timestamp descending.
 *
 * Each branch contributes up to `limit` candidates; the final result is
 * also capped at `limit`.
 *
 * SQLite does not support per-branch ORDER BY + LIMIT inside UNION ALL
 * parenthesized subqueries the way PostgreSQL does. Instead, each branch
 * is wrapped as a subquery (SELECT ... ORDER BY ... LIMIT ?) to achieve
 * the same effect.
 *
 * @param limit - max entries to return (defaults to FEED_DEFAULT_LIMIT)
 */
export function getActivityFeed(limit: number = FEED_DEFAULT_LIMIT): FeedEntry[] {
  const db = getDatabase();

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT 'session' as type, id, COALESCE(title, 'Session ' || substr(id, 1, 8)) as summary,
              COALESCE(ended_at, started_at) as timestamp
       FROM sessions ORDER BY started_at DESC LIMIT ?
    )

    UNION ALL

    SELECT * FROM (
      SELECT 'agent_run' as type, id, task || ' — ' || status as summary,
              COALESCE(completed_at, started_at) as timestamp
       FROM agent_runs ORDER BY started_at DESC LIMIT ?
    )

    UNION ALL

    SELECT * FROM (
      SELECT 'spore' as type, id, observation_type || ': ' || substr(content, 1, 80) as summary,
              created_at as timestamp
       FROM spores WHERE status = 'active' ORDER BY created_at DESC LIMIT ?
    )

    ORDER BY timestamp DESC LIMIT ?
  `).all(limit, limit, limit, limit) as FeedEntry[];

  return rows;
}
