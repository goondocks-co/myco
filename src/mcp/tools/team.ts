/**
 * myco_team — list team members registered in the vault.
 *
 * Queries the `team_members` table directly via PGlite.
 */

import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamInput {
  // No filters in Phase 1 — returns all team members.
}

interface TeamMember {
  id: string;
  user: string;
  role: string | null;
  joined: string | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoTeam(
  _input: TeamInput,
): Promise<TeamMember[]> {
  const db = getDatabase();

  const result = await db.query(
    `SELECT id, "user", role, joined, tags
     FROM team_members
     ORDER BY id ASC`,
  );

  return (result.rows as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    user: row.user as string,
    role: (row.role as string) ?? null,
    joined: (row.joined as string) ?? null,
    tags: row.tags ? (row.tags as string).split(',').map((t) => t.trim()) : [],
  }));
}
