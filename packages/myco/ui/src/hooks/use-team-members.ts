import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface TeamMember {
  id: string;
  user: string;
  role: string | null;
  joined: string | null;
  tags: string[];
  machine_id: string;
  synced_at: number | null;
}

export interface TeamMembersResponse {
  members: TeamMember[];
}

export function useTeamMembers(teamId?: string) {
  const suffix = teamId ? `?team_id=${encodeURIComponent(teamId)}` : '';
  return usePowerQuery<TeamMembersResponse>({
    queryKey: ['team-members', teamId ?? null],
    queryFn: ({ signal }) => fetchJson<TeamMembersResponse>(`/team/members${suffix}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
