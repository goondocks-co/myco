/**
 * myco_team — list team members registered in the vault.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

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
  client: DaemonClient,
): Promise<TeamMember[]> {
  const result = await client.get('/api/mcp/team');

  if (!result.ok || !result.data?.members) return [];

  return result.data.members as TeamMember[];
}
