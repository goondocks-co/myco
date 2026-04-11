import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface TeamStatusResponse {
  enabled: boolean;
  worker_url: string | null;
  has_api_key: boolean;
  api_key: string | null;
  healthy: boolean;
  health_error?: string;
  pending_sync_count: number;
  dead_letter_count: number;
  deployed_worker_version: string | null;
  worker_update_available: boolean;
  machine_id: string;
  package_version: string;
  schema_version: number;
  sync_protocol_version: number;
  mcp_token: string | null;
  mcp_endpoint: string | null;
}

export function useTeamStatus() {
  return usePowerQuery<TeamStatusResponse>({
    queryKey: ['team-status'],
    queryFn: ({ signal }) => fetchJson<TeamStatusResponse>('/team/status', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
