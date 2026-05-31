/**
 * Team member queries.
 */

import { getDatabase } from '../client.js';

export interface TeamMemberRow {
  id: string;
  user: string;
  role: string | null;
  joined: string | null;
  tags: string | null;
  machine_id: string;
  synced_at: number | null;
}

/** List all team members ordered by user name, with id as deterministic tiebreaker. */
export function listTeamMembers(): TeamMemberRow[] {
  return getDatabase().prepare(
    `SELECT id, "user", role, joined, tags, machine_id, synced_at
     FROM team_members
     ORDER BY "user" ASC, id ASC`,
  ).all() as TeamMemberRow[];
}

/**
 * Ensure a team_members row exists for the local machine. Idempotent:
 * a conflicting row is left untouched so any peer-synced edits to the
 * display name are not clobbered on every reconciliation tick.
 *
 * `user` defaults to the machine_id itself — the machine_id file is the
 * only stable local identity the daemon has at this layer; a friendlier
 * display name can be supplied later through member-management UI.
 *
 * Returns `{ inserted: true, row }` when the INSERT created the row;
 * `{ inserted: false, row }` when a row already existed.
 */
export function upsertSelfMember(machineId: string, joinedIso: string): {
  inserted: boolean;
  row: TeamMemberRow;
} {
  const info = getDatabase().prepare(
    `INSERT OR IGNORE INTO team_members (id, "user", role, joined, tags, machine_id)
     VALUES (?, ?, NULL, ?, NULL, ?)`,
  ).run(machineId, machineId, joinedIso, machineId);

  const row = getDatabase().prepare(
    `SELECT id, "user", role, joined, tags, machine_id, synced_at
     FROM team_members WHERE id = ?`,
  ).get(machineId) as TeamMemberRow;

  return { inserted: info.changes === 1, row };
}

/**
 * Reset the local machine's team_members row to unsynced so the next
 * unsynced sweep re-enqueues it. Used on join so a machine's self-row
 * re-fans to every team it now participates in (team_members.synced_at is
 * machine-global, so a prior sync would otherwise skip a newly joined team).
 * Returns the number of rows updated.
 */
export function markSelfMemberUnsynced(machineId: string): number {
  return getDatabase().prepare(
    `UPDATE team_members SET synced_at = NULL WHERE machine_id = ?`,
  ).run(machineId).changes;
}
