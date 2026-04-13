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
}

/** List all team members ordered by ID. */
export function listTeamMembers(): TeamMemberRow[] {
  return getDatabase().prepare(
    `SELECT id, "user", role, joined, tags
     FROM team_members
     ORDER BY id ASC`,
  ).all() as TeamMemberRow[];
}
