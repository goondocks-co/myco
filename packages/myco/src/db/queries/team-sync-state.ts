/**
 * Per-Grove team-sync enablement flag.
 *
 * A single row in each Grove DB recording whether this Grove syncs to the
 * team cloud. Read via the current `getDatabase()`, so enablement is scoped
 * to the Grove being written. An absent row means disabled.
 */

import { getDatabase } from '@myco/db/client.js';
import type { Database } from 'bun:sqlite';

export function getTeamSyncEnabled(db: Database = getDatabase()): boolean {
  const row = db
    .prepare('SELECT enabled FROM team_sync_state WHERE rowid_guard = 1')
    .get() as { enabled: number } | undefined;
  return row?.enabled === 1;
}

export function setTeamSyncEnabled(enabled: boolean, db: Database = getDatabase()): void {
  db.prepare(
    `INSERT INTO team_sync_state (rowid_guard, enabled) VALUES (1, ?)
     ON CONFLICT (rowid_guard) DO UPDATE SET enabled = excluded.enabled`,
  ).run(enabled ? 1 : 0);
}

/**
 * Replace this Grove's syncable-project set. Reconciled from the team registry
 * (projects in this Grove that belong to any team). The live `syncRow` gate and
 * `backfillRows` read this so a non-member project's rows are never enqueued.
 */
export function setProjectSyncMembership(
  projectIds: string[],
  db: Database = getDatabase(),
): void {
  const tx = db.transaction((ids: string[]) => {
    db.prepare('DELETE FROM team_sync_membership').run();
    const insert = db.prepare(
      'INSERT OR IGNORE INTO team_sync_membership (project_id) VALUES (?)',
    );
    for (const id of ids) insert.run(id);
  });
  tx(projectIds);
}

export function getSyncableProjectIds(db: Database = getDatabase()): string[] {
  return (
    db
      .prepare('SELECT project_id FROM team_sync_membership ORDER BY project_id')
      .all() as Array<{ project_id: string }>
  ).map((r) => r.project_id);
}

export function isProjectSyncable(
  projectId: string | null,
  db: Database = getDatabase(),
): boolean {
  if (projectId == null) return false;
  return (
    db
      .prepare('SELECT 1 FROM team_sync_membership WHERE project_id = ? LIMIT 1')
      .get(projectId) != null
  );
}
