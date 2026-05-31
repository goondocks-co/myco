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

/** Map the common member shape (local row or remote wire) to the UI DTO. */
function toMemberDto(m: TeamMemberRow | TeamMemberWire): TeamMemberDto {
  return {
    id: m.id,
    user: m.user,
    role: m.role,
    joined: m.joined,
    tags: splitTags(m.tags),
    machine_id: m.machine_id,
    synced_at: m.synced_at,
  };
}

/**
 * Local self-only roster. Used as the fallback whenever a team worker
 * cannot supply the roster (no team_id, unresolved client, or a failed
 * fetch).
 */
export const listTeamMembersHandler: RouteHandler = async () => {
  const rows = listTeamMembers();
  const body: ListTeamMembersResponse = { members: rows.map(toMemberDto) };
  return { body };
};

/**
 * Merge local member rows over a remote roster, deduped by machine_id. The
 * local rows win on collision because they carry this machine's accurate
 * `synced_at` / identity. This guarantees the user always sees themselves —
 * even against an old worker (pre-`team_members` migration) that returns an
 * empty `{members:[]}` without throwing.
 */
function mergeRosters(remote: TeamMemberDto[], local: TeamMemberDto[]): TeamMemberDto[] {
  const byMachine = new Map<string, TeamMemberDto>();
  for (const m of remote) byMachine.set(m.machine_id, m);
  for (const m of local) byMachine.set(m.machine_id, m);
  return [...byMachine.values()];
}

export function createListTeamMembersHandler(deps: {
  getTeamClientForId: (teamId: string) => { listMembers: () => Promise<{ members: TeamMemberWire[] }> } | null;
}): RouteHandler {
  return async (req) => {
    const teamId = typeof req.query?.team_id === 'string' && req.query.team_id ? req.query.team_id : null;
    const localDtos = listTeamMembers().map(toMemberDto);
    if (teamId) {
      const client = deps.getTeamClientForId(teamId);
      if (client) {
        try {
          const { members } = await client.listMembers();
          const merged = mergeRosters(members.map(toMemberDto), localDtos);
          return { body: { members: merged } satisfies ListTeamMembersResponse };
        } catch {
          // Worker unreachable — fall through to the local self-only roster.
        }
      }
    }
    return { body: { members: localDtos } satisfies ListTeamMembersResponse };
  };
}
