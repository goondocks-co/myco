import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

/** One line of a project's recent activity: a session that started, a run that ran, a spore that landed. */
export interface FeedItem {
  type: 'session' | 'run' | 'spore';
  id: string;
  summary: string;
  at: number;
  /** The Myco session the item belongs to, when it has one. A run's provider session ref is not one. */
  sessionId: string | null;
}

export const DEFAULT_FEED = 20;
export const MAX_FEED = 100;

/**
 * The project's recent activity, newest first, across sessions, runs and active
 * spores in one statement. Each source is bounded to the page before the union
 * so the outer sort never scans a whole table, and the wrapped `SELECT * FROM (…)`
 * shape is what SQLite admits inside a compound select.
 */
export async function activityFeed(db: RelationalStore, scope: ReadScope, limit?: number): Promise<FeedItem[]> {
  const n = limit === undefined || !Number.isSafeInteger(limit) || limit < 1 ? DEFAULT_FEED : Math.min(limit, MAX_FEED);
  const { results } = await db
    .prepare(`SELECT * FROM (
        SELECT 'session' AS type, session_id AS id,
               COALESCE(agent, 'session') || ' on ' || COALESCE(branch, '?') AS summary,
               COALESCE(started_at, first_received_at) AS at_ms, session_id AS session_id
          FROM sessions WHERE project_id = ? ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'run' AS type, id, COALESCE(task, 'run') || ' — ' || status AS summary,
               COALESCE(resumed_at, started_at) AS at_ms, NULL AS session_id
          FROM agent_runs WHERE project_id = ? AND started_at IS NOT NULL ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'spore' AS type, id, observation_type || ': ' || substr(content, 1, 80) AS summary,
               created_at AS at_ms, session_id
          FROM spores WHERE project_id = ? AND status = 'active' ORDER BY at_ms DESC LIMIT ?)
      ORDER BY at_ms DESC LIMIT ?`)
    .bind(scope.projectId, n, scope.projectId, n, scope.projectId, n, n)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    type: r.type as FeedItem['type'],
    id: r.id as string,
    summary: r.summary as string,
    at: r.at_ms as number,
    sessionId: (r.session_id as string | null) ?? null,
  }));
}
