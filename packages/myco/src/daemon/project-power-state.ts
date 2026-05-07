/**
 * Per-project power state tracker.
 *
 * The pre-Grove daemon ran one process per project, with a single
 * PowerManager whose `lastActivity` clock advanced whenever *that*
 * project saw input. The Grove-era daemon hosts many projects in one
 * process, so each project needs its own clock to keep that experience:
 *
 * - the project the user is actively viewing stays `active`;
 * - a project running a background symbiont (no UI focus) stays
 *   `active` as long as its events keep arriving;
 * - projects with no recent activity drift through `idle` → `sleep` →
 *   `deep_sleep` independently of every other project on the daemon.
 *
 * The tracker is intentionally pure: it owns nothing but the per-project
 * `lastActivity` map and the threshold config. The scheduler decides
 * what to do with each state — including any deep-sleep hold computed
 * from accelerator backlogs, which lives in the scheduler because it
 * depends on per-task accelerator dispatch and shouldn't couple back
 * into the tracker.
 */

import type { GroveProjectId } from '@myco/grove/ids.js';
import type { Database } from '@myco/db/client.js';
import type { PowerState } from './power.js';
import { getAllProjectActivitySeconds } from '@myco/db/queries/project-activity.js';

export type { PowerState };

export interface ProjectPowerStateConfig {
  /** ms without activity before transitioning to `idle`. */
  idleThresholdMs: number;
  /** ms without activity before transitioning to `sleep`. */
  sleepThresholdMs: number;
  /** ms without activity before transitioning to `deep_sleep`. */
  deepSleepThresholdMs: number;
}

/**
 * A project key combines `groveId` and `projectId`. Project ids are only
 * unique within a Grove, so we always carry the Grove identifier with
 * them to avoid collisions across Groves.
 */
export interface ProjectKey {
  groveId: string;
  projectId: GroveProjectId;
}

interface SeedRow {
  groveId: string;
  projectId: GroveProjectId;
  lastActivityMs: number;
}

function key(groveId: string, projectId: GroveProjectId): string {
  return `${groveId}:${projectId}`;
}

export class ProjectPowerStateTracker {
  private readonly lastActivity = new Map<string, number>();
  private readonly config: ProjectPowerStateConfig;

  constructor(config: ProjectPowerStateConfig) {
    this.config = config;
  }

  /** Mark a project as having just done something interesting. */
  recordActivity(groveId: string, projectId: GroveProjectId, now = Date.now()): void {
    this.lastActivity.set(key(groveId, projectId), now);
  }

  /**
   * Bulk-seed the activity map from durable state. Existing entries are
   * only overwritten when the seed value is newer, so a seed pass that
   * runs after live activity has already been recorded never regresses
   * the clock.
   */
  seed(rows: Iterable<SeedRow>): void {
    for (const row of rows) {
      const k = key(row.groveId, row.projectId);
      const existing = this.lastActivity.get(k);
      if (existing === undefined || row.lastActivityMs > existing) {
        this.lastActivity.set(k, row.lastActivityMs);
      }
    }
  }

  /**
   * Resolve the current power state for a project.
   *
   * Projects with no recorded activity are treated as `deep_sleep` —
   * a daemon-restart safe default that keeps un-seeded scopes from
   * accidentally counting as `active` while the seed query catches up.
   */
  getState(groveId: string, projectId: GroveProjectId, now = Date.now()): PowerState {
    const last = this.lastActivity.get(key(groveId, projectId));
    if (last === undefined) return 'deep_sleep';
    const idleMs = now - last;
    if (idleMs >= this.config.deepSleepThresholdMs) return 'deep_sleep';
    if (idleMs >= this.config.sleepThresholdMs) return 'sleep';
    if (idleMs >= this.config.idleThresholdMs) return 'idle';
    return 'active';
  }

  /**
   * Same as `getState` but transparently treats `deep_sleep` as `sleep`
   * when `holdDeepSleep` is true. Encapsulates the "accelerator says
   * there's pending work" hold pattern from the global PowerManager so
   * each scheduled task only has to decide whether the hold applies for
   * its work unit.
   */
  getStateWithHold(
    groveId: string,
    projectId: GroveProjectId,
    holdDeepSleep: boolean,
    now = Date.now(),
  ): PowerState {
    const raw = this.getState(groveId, projectId, now);
    if (raw === 'deep_sleep' && holdDeepSleep) return 'sleep';
    return raw;
  }

  /** For tests / observability. */
  getLastActivity(groveId: string, projectId: GroveProjectId): number | undefined {
    return this.lastActivity.get(key(groveId, projectId));
  }

  /** Forget any recorded activity for a project (e.g. project removed). */
  clear(groveId: string, projectId: GroveProjectId): void {
    this.lastActivity.delete(key(groveId, projectId));
  }

  /**
   * Forget every project under the given Grove (e.g. Grove removed).
   * Bounded by registered projects in the meantime — no unregister flow
   * exists today, so call sites are exclusively forward-looking.
   */
  clearForGrove(groveId: string): void {
    const prefix = `${groveId}:`;
    for (const k of this.lastActivity.keys()) {
      if (k.startsWith(prefix)) this.lastActivity.delete(k);
    }
  }
}

// Boot seeding so daemon restarts don't collapse warm projects to deep_sleep
// before any new traffic arrives.
export function readProjectActivitySeed(
  db: Database,
  groveId: string,
): SeedRow[] {
  return getAllProjectActivitySeconds(db).map((row) => ({
    groveId,
    projectId: row.project_id as GroveProjectId,
    lastActivityMs: row.last_seconds * 1000,
  }));
}
