import type { Database, Statement } from 'bun:sqlite';
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

/**
 * Count completed-or-failed runs of `taskName` for `projectId` whose
 * `started_at` is at-or-after `sinceSeconds`. Used by the scheduler to
 * enforce the per-task `maxRunsPerDay` ceiling — the accelerator decides
 * cadence within the window, this count caps the window.
 *
 * Counts terminal runs only; in-flight runs don't count toward the
 * ceiling (the existing `isTaskRunning` guard already prevents overlap).
 *
 * Uses the existing `idx_agent_runs_task_status_started_at` index for
 * cheap per-tick reads.
 */
export function countTaskRunsSince(
  db: Database,
  projectId: GroveProjectId,
  taskName: string,
  sinceSeconds: number,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM agent_runs
      WHERE project_id = ?
        AND task = ?
        AND status IN ('completed', 'failed')
        AND started_at >= ?`,
  ).get(projectId, taskName, sinceSeconds) as { n: number } | undefined;
  return row?.n ?? 0;
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

// ---------------------------------------------------------------------------
// Batched activity-with-backlog
// ---------------------------------------------------------------------------
//
// `/api/projects/activity` handles N projects per Grove, each previously
// resolved by a single-row `getProjectActivityWithBacklog` call. With many
// projects, the round-trip cost dominates — and every per-project query
// re-prepared the same SQL. The batched form below issues three indexed
// `GROUP BY project_id` scans (sessions, prompt_batches, agent_runs)
// filtered by the request's project-id list using `WHERE project_id IN
// (SELECT value FROM json_each(?))`. The IN-clause shape lets a single
// prepared statement handle any project-id-list cardinality without
// re-preparing.
//
// Statements are memoized per `Database` instance via a module-scope
// `WeakMap`. Memoization is keyed on the DB handle so multiple Groves
// each get their own prepared-statement cache and no statement leaks
// across closed handles (the handle is the GC root).

interface BatchedStatements {
  sessions: Statement<{ project_id: string; last: number | null }, [string]>;
  prompts: Statement<{ project_id: string; last: number | null }, [string]>;
  runs: Statement<
    { project_id: string; n: number },
    [string, number]
  >;
}

const STATEMENT_CACHE = new WeakMap<Database, BatchedStatements>();

function getBatchedStatements(db: Database): BatchedStatements {
  const cached = STATEMENT_CACHE.get(db);
  if (cached) return cached;
  const stmts: BatchedStatements = {
    sessions: db.prepare(
      `SELECT project_id, MAX(created_at) AS last
         FROM sessions
        WHERE project_id IN (SELECT value FROM json_each(?))
        GROUP BY project_id`,
    ),
    prompts: db.prepare(
      `SELECT project_id, MAX(created_at) AS last
         FROM prompt_batches
        WHERE project_id IN (SELECT value FROM json_each(?))
        GROUP BY project_id`,
    ),
    runs: db.prepare(
      `SELECT project_id, COUNT(*) AS n
         FROM agent_runs
        WHERE project_id IN (SELECT value FROM json_each(?))
          AND started_at IS NOT NULL
          AND started_at >= ?
        GROUP BY project_id`,
    ),
  };
  STATEMENT_CACHE.set(db, stmts);
  return stmts;
}

/**
 * Batched form of `getProjectActivityWithBacklog`: collects the same
 * `(last_seconds, scheduled_runs_in_window)` tuple for every project in
 * `projectIds` with at most three indexed `GROUP BY project_id` scans.
 *
 * Replaces an N-round-trip per-Grove loop in `/api/projects/activity`.
 * Returns a `Map` keyed by `project_id`. Projects with no rows in any of
 * the three source tables are absent from the map (callers should fall
 * back to `{ last_seconds: null, scheduled_runs_in_window: 0 }`).
 *
 * Empty `projectIds` short-circuits to an empty Map without preparing
 * the statements.
 */
export function getActivityWithBacklogForProjects(
  db: Database,
  projectIds: readonly GroveProjectId[],
  windowStartSeconds: number,
): Map<GroveProjectId, ProjectActivityWithBacklog> {
  const out = new Map<GroveProjectId, ProjectActivityWithBacklog>();
  if (projectIds.length === 0) return out;

  const idsJson = JSON.stringify(projectIds);
  const stmts = getBatchedStatements(db);

  // Pre-seed an entry for every requested id so callers iterating the
  // input list always find a value; downstream merges only set fields
  // they actually observe.
  for (const id of projectIds) {
    out.set(id, { last_seconds: null, scheduled_runs_in_window: 0 });
  }

  const merge = (projectId: string, value: number | null): void => {
    if (value == null) return;
    const id = projectId as GroveProjectId;
    const entry = out.get(id);
    if (!entry) return;
    if (entry.last_seconds == null || value > entry.last_seconds) {
      entry.last_seconds = value;
    }
  };

  for (const row of stmts.sessions.all(idsJson)) merge(row.project_id, row.last);
  for (const row of stmts.prompts.all(idsJson)) merge(row.project_id, row.last);

  for (const row of stmts.runs.all(idsJson, windowStartSeconds)) {
    const entry = out.get(row.project_id as GroveProjectId);
    if (!entry) continue;
    entry.scheduled_runs_in_window = row.n;
  }

  return out;
}
