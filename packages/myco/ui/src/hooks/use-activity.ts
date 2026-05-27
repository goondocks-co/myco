import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface ActivityEvent {
  type: string;
  id: string;
  summary: string;
  timestamp: number;
}

export function useActivity(limit = 20) {
  return usePowerQuery<ActivityEvent[]>({
    queryKey: ['activity', limit],
    queryFn: ({ signal }) =>
      fetchJson<ActivityEvent[]>(`/activity?limit=${limit}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
