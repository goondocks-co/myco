/**
 * Activity feed query — unified timeline across sessions, agent_runs, and spores.
 *
 * Uses UNION ALL with per-branch ORDER BY + LIMIT, then a final ORDER BY + LIMIT
 * to produce a cross-table timeline ordered by timestamp descending.
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
 * @param limit — max entries to return (defaults to FEED_DEFAULT_LIMIT)
 */
export async function getActivityFeed(limit: number = FEED_DEFAULT_LIMIT): Promise<FeedEntry[]> {
  const db = getDatabase();
  // Each subquery is wrapped in parens for valid UNION ALL with per-branch ORDER BY + LIMIT
  const result = await db.query(`
    (SELECT 'session' as type, id, COALESCE(title, 'Session ' || LEFT(id, 8)) as summary,
            COALESCE(ended_at, started_at) as timestamp
     FROM sessions ORDER BY started_at DESC LIMIT $1)

    UNION ALL

    (SELECT 'agent_run' as type, id, task || ' — ' || status as summary,
            COALESCE(completed_at, started_at) as timestamp
     FROM agent_runs ORDER BY started_at DESC LIMIT $1)

    UNION ALL

    (SELECT 'spore' as type, id, observation_type || ': ' || LEFT(content, 80) as summary,
            created_at as timestamp
     FROM spores WHERE status = 'active' ORDER BY created_at DESC LIMIT $1)

    ORDER BY timestamp DESC LIMIT $1
  `, [limit]);
  return result.rows as FeedEntry[];
}
