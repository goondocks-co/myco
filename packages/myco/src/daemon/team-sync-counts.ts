/**
 * Cross-grove aggregation of a team's local sync counts.
 *
 * Team membership is machine-wide — a single team can own projects that live
 * in different groves — but each grove keeps its own SQLite DB. A team-scoped
 * read (Sync/Status) therefore cannot be answered from one grove-scoped
 * `getDatabase()` handle: projects in other groves would silently count zero.
 *
 * `forEachGrove` pins each grove's DB (and asserts this daemon owns it) for the
 * duration of the body, so the `getDatabase()`-based count helpers read the
 * correct file. Groves absent from this daemon's home are never visited, which
 * is also the served-by boundary: a team project served by a different daemon
 * contributes nothing here.
 */

import {
  countPendingForProjects,
  countTeamSyncRows,
  TEAM_SYNC_OBSERVED_TABLES,
  type TeamSyncObservedTable,
} from '@myco/db/queries/team-outbox.js';
import { forEachGrove } from './scope-iteration.js';
import type { GroveRuntimeCache } from './grove-runtime-cache.js';
import type { Logger } from './logger.js';

/** A team's project as recorded in the machine-wide team registry. */
export interface TeamProjectRef {
  grove_id: string;
  project_id: string;
}

export interface TeamSyncRowAggregate {
  /** Per-table local row counts summed across every served grove. */
  tables: Record<TeamSyncObservedTable, number>;
  /** Pending outbox rows summed across every served grove. */
  pending: number;
  /**
   * How many of the team's groves are served by this daemon (present in its
   * home and successfully visited). Zero means this machine serves none of the
   * team — the caller renders the "home does not serve this team" state.
   */
  grovesServed: number;
}

function emptyCounts(): Record<TeamSyncObservedTable, number> {
  const counts = {} as Record<TeamSyncObservedTable, number>;
  for (const table of TEAM_SYNC_OBSERVED_TABLES) counts[table] = 0;
  return counts;
}

/**
 * Sum a team's local row + pending counts across every grove on this machine
 * that owns one of the team's projects. The ambient request grove is
 * irrelevant — the team is the scope.
 */
export async function aggregateTeamSyncRows(
  cache: GroveRuntimeCache,
  logger: Logger,
  machineId: string,
  projects: readonly TeamProjectRef[],
): Promise<TeamSyncRowAggregate> {
  const projectsByGrove = new Map<string, string[]>();
  for (const project of projects) {
    const list = projectsByGrove.get(project.grove_id) ?? [];
    list.push(project.project_id);
    projectsByGrove.set(project.grove_id, list);
  }

  const tables = emptyCounts();
  let pending = 0;
  let grovesServed = 0;

  // Sequential (no `parallel`) so the shared accumulators never interleave.
  // Teams span a handful of groves; the extra wall-clock is negligible.
  await forEachGrove(
    cache,
    logger,
    ({ grove }) => {
      const projectIds = projectsByGrove.get(grove.id);
      if (!projectIds || projectIds.length === 0) return;
      grovesServed += 1;
      // forEachGrove has already pinned this grove's DB via withDatabase, so
      // the getDatabase()-based helpers below read this grove's file.
      const groveCounts = countTeamSyncRows(machineId, projectIds);
      for (const table of TEAM_SYNC_OBSERVED_TABLES) tables[table] += groveCounts[table];
      pending += countPendingForProjects(projectIds);
    },
    {
      jobName: 'team-sync-summary-counts',
      shouldVisitGrove: (grove) => projectsByGrove.has(grove.id),
    },
  );

  return { tables, pending, grovesServed };
}
