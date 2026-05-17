/**
 * `GET /api/team/members` — list local team_members rows for the UI.
 *
 * Read-only handler that hydrates the Members tab on the Team page. The DTO
 * splits the comma-joined `tags` column into a string array and surfaces
 * `machine_id` / `synced_at` so the UI can render team-sync provenance.
 */

import type { RouteHandler } from '../router.js';
import { listTeamMembers, type TeamMemberRow } from '../../db/queries/team-members.js';

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

function rowToDto(row: TeamMemberRow): TeamMemberDto {
  return {
    id: row.id,
    user: row.user,
    role: row.role,
    joined: row.joined,
    tags: row.tags ? row.tags.split(',').map((s) => s.trim()).filter(Boolean) : [],
    machine_id: row.machine_id,
    synced_at: row.synced_at,
  };
}

export function createListTeamMembersHandler(): RouteHandler {
  return async () => {
    const rows = listTeamMembers();
    const body: ListTeamMembersResponse = { members: rows.map(rowToDto) };
    return { body };
  };
}
