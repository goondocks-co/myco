/**
 * `GET /api/team/members` — the selected team's member roster for the UI.
 *
 * Read-only handler that hydrates the Members tab on the Team page. When a
 * `team_id` query param resolves a team client, the roster is fetched from
 * that team's worker (the union of every node's `team_members` rows);
 * otherwise (no team_id, no client, or an unreachable worker) it falls back
 * to the local self-only roster. The DTO splits the comma-joined `tags`
 * column into a string array and surfaces `machine_id` / `synced_at` so the
 * UI can render team-sync provenance.
 */

import type { RouteHandler } from '../router.js';
import { listTeamMembers, type TeamMemberRow } from '../../db/queries/team-members.js';
import type { TeamMemberWire } from '../team-sync.js';

export interface TeamMemberDto {
  id: string;
  user: string;
  role: string | null;
  joined: string | null;
  tags: string[];
  machine_id: string;
  synced_at: number | null;
}

export interface ListTeamMembersResponse {
  members: TeamMemberDto[];
}

function splitTags(tags: string | null): string[] {
  return tags ? tags.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

function rowToDto(row: TeamMemberRow): TeamMemberDto {
  return {
    id: row.id,
    user: row.user,
    role: row.role,
    joined: row.joined,
    tags: splitTags(row.tags),
    machine_id: row.machine_id,
    synced_at: row.synced_at,
  };
}

function wireToDto(w: TeamMemberWire): TeamMemberDto {
  return {
    id: w.id,
    user: w.user,
    role: w.role,
    joined: w.joined,
    tags: splitTags(w.tags),
    machine_id: w.machine_id,
    synced_at: w.synced_at,
  };
}

/**
 * Local self-only roster. Used as the fallback whenever a team worker
 * cannot supply the roster (no team_id, unresolved client, or a failed
 * fetch).
 */
export const listTeamMembersHandler: RouteHandler = async () => {
  const rows = listTeamMembers();
  const body: ListTeamMembersResponse = { members: rows.map(rowToDto) };
  return { body };
};

export function createListTeamMembersHandler(deps: {
  getTeamClientForId: (teamId: string) => { listMembers: () => Promise<{ members: TeamMemberWire[] }> } | null;
}): RouteHandler {
  return async (req) => {
    const teamId = typeof req.query?.team_id === 'string' && req.query.team_id ? req.query.team_id : null;
    if (teamId) {
      const client = deps.getTeamClientForId(teamId);
      if (client) {
        try {
          const { members } = await client.listMembers();
          const body: ListTeamMembersResponse = { members: members.map(wireToDto) };
          return { body };
        } catch {
          // Worker unreachable — fall through to the local self-only roster.
        }
      }
    }
    const rows = listTeamMembers();
    return { body: { members: rows.map(rowToDto) } satisfies ListTeamMembersResponse };
  };
}
