/**
 * Per-Grove team-sync enablement flag.
 *
 * A single row in each Grove DB. Read by BOTH the TS upsert gate
 * (`syncRow`) and the SQL `AFTER DELETE` triggers — both via the current
 * `getDatabase()` — so "is this Grove syncing" is Grove-correct by
 * construction. Absent row == disabled.
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
