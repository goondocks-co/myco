import type { Database } from 'bun:sqlite';
import type { GroveProjectId } from '@myco/grove/ids.js';

export interface ProjectActivitySeedRow {
  project_id: string;
  /** Most recent session/prompt-batch `created_at` for this project, in epoch seconds. */
  last_seconds: number;
}

/**
 * Most recent activity (sessions ∪ prompt_batches.created_at) for a single
 * project, in epoch seconds. Returns null when the project has no activity.
 *
 * Used as the single source of truth for the project-recency signal —
 * `isProjectActive`, the projects-activity API, and the project-power-state
 * seed all derive their gates from this primitive.
 */
export function getProjectActivitySeconds(
  db: Database,
  projectId: GroveProjectId,
): number | null {
  const row = db.prepare(
    `SELECT MAX(t) AS last_seconds FROM (
       SELECT MAX(created_at) AS t FROM sessions WHERE project_id = ?
       UNION ALL
       SELECT MAX(created_at) AS t FROM prompt_batches WHERE project_id = ?
     )`,
  ).get(projectId, projectId) as { last_seconds: number | null } | undefined;
  return row?.last_seconds ?? null;
}

/**
 * Bulk variant: most recent activity per project_id across the Grove DB.
 * Used at boot to seed `ProjectPowerStateTracker` so a daemon restart
 * does not collapse warm projects to deep_sleep before traffic arrives.
 */
export function getAllProjectActivitySeconds(db: Database): ProjectActivitySeedRow[] {
  const rows = db.prepare(
    `SELECT project_id, MAX(last_seconds) AS last_seconds FROM (
       SELECT project_id, MAX(created_at) AS last_seconds
       FROM sessions
       WHERE project_id IS NOT NULL
       GROUP BY project_id
       UNION ALL
       SELECT project_id, MAX(created_at) AS last_seconds
       FROM prompt_batches
       WHERE project_id IS NOT NULL
       GROUP BY project_id
     )
     GROUP BY project_id`,
  ).all() as Array<{ project_id: string | null; last_seconds: number | null }>;

  const out: ProjectActivitySeedRow[] = [];
  for (const row of rows) {
    if (!row.project_id || row.last_seconds == null) continue;
    out.push({ project_id: row.project_id, last_seconds: row.last_seconds });
  }
  return out;
}

export interface LastTaskRunRow {
  task: string;
  last_completed_seconds: number;
}

/**
 * Most-recent terminal `agent_runs.completed_at` per task for a single
 * project. Used by the scheduler to lazy-seed `lastRun` when a project
 * appears after boot — without this, the first warm tick would fire
 * tasks regardless of how recently they ran on that project before the
 * daemon came up.
 */
export function getLastCompletedRunsForProject(
  db: Database,
  projectId: GroveProjectId,
  floorSeconds: number,
): LastTaskRunRow[] {
  const rows = db.prepare(
    `SELECT task, MAX(completed_at) AS last_completed
       FROM agent_runs
      WHERE project_id = ?
        AND status IN ('completed', 'failed')
        AND completed_at IS NOT NULL
        AND completed_at >= ?
        AND task IS NOT NULL
      GROUP BY task`,
  ).all(projectId, floorSeconds) as Array<{ task: string; last_completed: number }>;
  return rows.map((r) => ({ task: r.task, last_completed_seconds: r.last_completed }));
}

export interface ProjectActivityWithBacklog {
  /** Most recent session/prompt-batch `created_at`, epoch seconds, or null. */
  last_seconds: number | null;
  /** Count of `agent_runs` rows started in the activity window. */
  scheduled_runs_in_window: number;
}

/**
 * Single round-trip projecting both the latest activity and the count of
 * scheduled agent_runs started within `windowStartSeconds`. Used by the
 * /api/projects/activity endpoint, which needs both stats per project.
 */
export function getProjectActivityWithBacklog(
  db: Database,
  projectId: GroveProjectId,
  windowStartSeconds: number,
): ProjectActivityWithBacklog {
  const row = db.prepare(
    `SELECT
       (
         SELECT MAX(t) FROM (
           SELECT MAX(created_at) AS t FROM sessions WHERE project_id = ?
           UNION ALL
           SELECT MAX(created_at) AS t FROM prompt_batches WHERE project_id = ?
         )
       ) AS last_seconds,
       (
         SELECT COUNT(*) FROM agent_runs
         WHERE project_id = ?
           AND started_at IS NOT NULL
           AND started_at >= ?
       ) AS scheduled_runs_in_window`,
  ).get(projectId, projectId, projectId, windowStartSeconds) as {
    last_seconds: number | null;
    scheduled_runs_in_window: number;
  };
  return row;
}
