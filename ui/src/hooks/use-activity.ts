import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface ActivityEvent {
  id: string;
  event_type: string;
  session_id: string | null;
  summary: string;
  created_at: string;
}

export interface ActivityResponse {
  events: ActivityEvent[];
}

export function useActivity(limit = 20) {
  return usePowerQuery<ActivityResponse>({
    queryKey: ['activity', limit],
    queryFn: ({ signal }) =>
      fetchJson<ActivityResponse>(`/activity?limit=${limit}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
