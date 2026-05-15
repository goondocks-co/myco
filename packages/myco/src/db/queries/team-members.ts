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

/** List all team members ordered by user name. */
export function listTeamMembers(): TeamMemberRow[] {
  return getDatabase().prepare(
    `SELECT id, "user", role, joined, tags, machine_id, synced_at
     FROM team_members
     ORDER BY "user" ASC`,
  ).all() as TeamMemberRow[];
}
