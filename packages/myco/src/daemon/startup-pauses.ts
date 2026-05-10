import type { DaemonLogger } from './logger.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import {
  forceResumeProject,
  isProjectPaused,
  listGroves,
  listRegisteredProjects,
} from '@myco/grove/registry.js';
import { resolveMycoHome } from '@myco/grove/paths.js';

/**
 * Time-based orphan threshold. Move/vacuum operations complete in seconds;
 * a pause older than this is by definition abandoned (the daemon process
 * that took the lock is dead — no operation type currently registers a
 * keepalive across daemon restarts).
 *
 * Carve-out: remove this fallback once each operation registers its own
 * keepalive (e.g. a marker file with mtime updates) so we can tell the
 * difference between "in flight" and "abandoned" without leaning on time
 * alone.
 */
export const ORPHAN_PAUSE_STALENESS_SECONDS = 60 * 60;

export interface ResumeOrphanedPausesOptions {
  /** Optional override; defaults to `Date.now()` evaluated at call time. */
  now?: () => number;
  /** Override for the staleness window in seconds (tests). */
  stalenessSeconds?: number;
  mycoHome?: string;
}

export interface ResumeOrphanedPausesResult {
  scanned: number;
  resumed: number;
  preserved: number;
}

/**
 * Sweep every registered project across every Grove on this machine and
 * force-resume any pause whose `since` timestamp is older than the
 * staleness threshold. Logs each force-resume so operators can trace
 * which op was holding the lock when the previous daemon died.
 */
export function resumeOrphanedPauses(
  logger: DaemonLogger,
  options: ResumeOrphanedPausesOptions = {},
): ResumeOrphanedPausesResult {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const stalenessSeconds = options.stalenessSeconds ?? ORPHAN_PAUSE_STALENESS_SECONDS;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);

  let scanned = 0;
  let resumed = 0;
  let preserved = 0;

  const groves = listGroves(mycoHome);
  for (const grove of groves) {
    const projects = listRegisteredProjects(grove.id, mycoHome);
    for (const project of projects) {
      scanned += 1;
      const status = isProjectPaused(project.project_id, mycoHome);
      if (!status.paused) continue;
      const ageSeconds = nowSeconds - status.since;
      if (ageSeconds < stalenessSeconds) {
        preserved += 1;
        continue;
      }
      try {
        forceResumeProject(grove.id, project.project_id, 'orphan-cleanup', mycoHome);
        resumed += 1;
        logger.warn(LOG_KINDS.DAEMON_START, 'Resumed orphaned pause on startup', {
          grove_id: grove.id,
          project_id: project.project_id,
          owner_op: status.owner_op,
          reason: status.reason,
          age_seconds: ageSeconds,
        });
      } catch (err) {
        logger.error(LOG_KINDS.DAEMON_START, 'Failed to force-resume orphaned pause', {
          grove_id: grove.id,
          project_id: project.project_id,
          error: (err as Error).message,
        });
      }
    }
  }

  return { scanned, resumed, preserved };
}
