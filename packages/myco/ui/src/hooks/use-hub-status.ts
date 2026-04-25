import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface HubStatusResponse {
  configured: boolean;
  url: string;
  running: boolean;
  error: string | null;
}

export function useHubStatus() {
  return usePowerQuery<HubStatusResponse>({
    queryKey: ['hub-status'],
    queryFn: ({ signal }) => fetchJson<HubStatusResponse>('/hub/status', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
    retry: 1,
  });
}
