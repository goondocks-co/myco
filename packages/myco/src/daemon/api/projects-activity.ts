import type { RouteRequest, RouteResponse } from '../router.js';
import type { Logger } from '../logger.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { GroveRuntimeCache } from '../grove-runtime-cache.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { GroveRecord, RegisteredProject } from '@myco/grove/registry.js';
import { listRegisteredProjects } from '@myco/grove/registry.js';
import { resolveMycoHome, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { MS_PER_DAY, epochSeconds } from '@myco/constants.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getProjectActivityWithBacklog } from '@myco/db/queries/project-activity.js';
import { forEachGrove, type GroveScope } from '../scope-iteration.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectActivityRow {
  grove_id: string;
  grove_slug: string;
  project_id: GroveProjectId;
  project_name: string;
  project_root: string;
  project_vault_dir: string;
  /** ISO timestamp of the most recent session or prompt batch, or null. */
  last_activity_at: string | null;
  /** Number of `agent_runs` rows started in the last 24 hours for this project. */
  scheduled_runs_last_24h: number;
  /** True if this project is within the configured active window. */
  is_active: boolean;
}

export interface ProjectsActivityResponse {
  projects: ProjectActivityRow[];
  /** The active-window threshold (days) used to compute `is_active`. */
  active_window_days: number;
  /** ISO timestamp the data is correct as of. */
  generated_at: string;
}

export interface ProjectsActivityHandlersDeps {
  logger: Logger;
  liveConfig: { current: MycoConfig };
  cache: GroveRuntimeCache;
  mycoHome?: string;
}

const SECONDS_PER_DAY = MS_PER_DAY / 1000;

function buildProjectRow(
  scope: GroveScope,
  project: RegisteredProject,
  activeWindowSeconds: number,
  nowSeconds: number,
): ProjectActivityRow {
  const projectId = assertGroveProjectId(project.project_id);
  const cutoff = nowSeconds - activeWindowSeconds;
  const twentyFourHoursAgo = nowSeconds - SECONDS_PER_DAY;
  const activity = getProjectActivityWithBacklog(scope.db, projectId, twentyFourHoursAgo);
  return {
    grove_id: scope.grove.id,
    grove_slug: scope.grove.slug,
    project_id: projectId,
    project_name: project.name,
    project_root: project.root,
    project_vault_dir: resolveProjectVaultDir(project.root),
    last_activity_at: activity.last_seconds
      ? new Date(activity.last_seconds * 1000).toISOString()
      : null,
    scheduled_runs_last_24h: activity.scheduled_runs_in_window,
    is_active: activity.last_seconds !== null && activity.last_seconds >= cutoff,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function createProjectsActivityHandler(deps: ProjectsActivityHandlersDeps) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  return async function handleProjectsActivity(_req: RouteRequest): Promise<RouteResponse> {
    const config = deps.liveConfig.current;
    const activeWindowDays = config.agent.cold_project_threshold_days ?? 14;
    const activeWindowSeconds = activeWindowDays * SECONDS_PER_DAY;
    const nowSeconds = epochSeconds();

    const projects: ProjectActivityRow[] = [];
    await forEachGrove(
      deps.cache,
      deps.logger,
      (scope) => {
        const groveProjects = listRegisteredProjects(scope.grove.id, mycoHome);
        for (const project of groveProjects) {
          try {
            projects.push(buildProjectRow(scope, project, activeWindowSeconds, nowSeconds));
          } catch (err) {
            // Keep the row so the UI still shows the project in its registered list.
            deps.logger.warn(
              LOG_KINDS.DAEMON_START,
              'project-activity row build failed',
              {
                grove_id: scope.grove.id,
                project_id: project.project_id,
                error: errorMessage(err),
              },
            );
            projects.push(neutralRow(scope.grove, project));
          }
        }
      },
      { mycoHome, jobName: 'projects-activity', parallel: true },
    );

    // Active first, then by last activity desc — cold projects sink to bottom.
    projects.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      const aTs = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
      const bTs = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
      return bTs - aTs;
    });

    const body: ProjectsActivityResponse = {
      projects,
      active_window_days: activeWindowDays,
      generated_at: new Date().toISOString(),
    };
    return { body };
  };
}

function neutralRow(grove: GroveRecord, project: RegisteredProject): ProjectActivityRow {
  return {
    grove_id: grove.id,
    grove_slug: grove.slug,
    project_id: assertGroveProjectId(project.project_id),
    project_name: project.name,
    project_root: project.root,
    project_vault_dir: resolveProjectVaultDir(project.root),
    last_activity_at: null,
    scheduled_runs_last_24h: 0,
    is_active: false,
  };
}
