import type { RelationalStore as activity_import_RelationalStore } from "../../core/adapters.js";
import type { ReadScope as activity_import_ReadScope } from "../scope.js";
import { notTombstonedSql as activity_import_notTombstonedSql } from "../../db/session-read-model.js";
import { sessions_SESSION_OCCURRED_AT, sessions_firstPromptSql, sessions_sessionLabel } from './sessions.js';

/** One line of a project's recent activity: a session that started, a run that ran, a spore that landed. */
interface activity_FeedItem {
  type: 'session' | 'run' | 'spore';
  id: string;
  summary: string;
  at: number;
  /** The Myco session the item belongs to, when it has one. A run's provider session ref is not one. */
  sessionId: string | null;
}

const activity_DEFAULT_FEED = 20;

const activity_MAX_FEED = 100;

/**
 * The project's recent activity, newest first, across sessions, runs and active
 * spores in one statement. Each source is bounded to the page before the union
 * so the outer sort never scans a whole table, and the wrapped `SELECT * FROM (…)`
 * shape is what SQLite admits inside a compound select. A session line carries
 * the same label the session list shows; the other sources fill its columns with
 * NULL so the compound select stays uniform.
 */
async function activity_activityFeed(db: activity_import_RelationalStore, scope: activity_import_ReadScope, limit?: number): Promise<activity_FeedItem[]> {
  const n = limit === undefined || !Number.isSafeInteger(limit) || limit < 1 ? activity_DEFAULT_FEED : Math.min(limit, activity_MAX_FEED);
  const rows=await (async()=>{
  const { results } = await db.prepare(`SELECT * FROM (
        SELECT 'session' AS type, s.session_id AS id, '' AS summary,
               ${sessions_SESSION_OCCURRED_AT} AS at_ms, s.session_id AS session_id,
               s.title AS title, ${sessions_firstPromptSql('s')} AS first_prompt, s.agent AS agent
          FROM sessions s WHERE s.project_id = ? AND ${activity_import_notTombstonedSql('s')} ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'run' AS type, id, COALESCE(task, 'run') || ' — ' || status AS summary,
               COALESCE(resumed_at, started_at, completed_at, queued_at) AS at_ms, NULL AS session_id, NULL AS title, NULL AS first_prompt, NULL AS agent
          FROM agent_runs WHERE project_id = ? AND COALESCE(resumed_at, started_at, completed_at, queued_at) IS NOT NULL ORDER BY at_ms DESC LIMIT ?)
      UNION ALL SELECT * FROM (
        SELECT 'spore' AS type, id, observation_type || ': ' || substr(content, 1, 80) AS summary,
               created_at AS at_ms, session_id, NULL AS title, NULL AS first_prompt, NULL AS agent
          FROM spores WHERE project_id = ? AND status = 'active' ORDER BY at_ms DESC LIMIT ?)
      ORDER BY at_ms DESC LIMIT ?`).bind(...[scope.projectId,n,scope.projectId,n,scope.projectId,n,n])
    .all<Record<string, unknown>>();
  return results;
  })();
  return rows.map((r) => ({
    type: r.type as activity_FeedItem['type'],
    id: r.id as string,
    summary: r.type === 'session'
      ? sessions_sessionLabel((r.title as string | null) ?? null, (r.first_prompt as string | null) ?? null, (r.agent as string | null) ?? null, r.id as string)
      : r.summary as string,
    at: r.at_ms as number,
    sessionId: (r.session_id as string | null) ?? null,
  }));
}

export { activity_MAX_FEED, activity_activityFeed };
