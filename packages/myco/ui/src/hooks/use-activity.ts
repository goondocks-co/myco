import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { useProjectScopedQueryKey } from './use-project-selection';

export interface ActivityEvent {
  type: string;
  id: string;
  summary: string;
  timestamp: number;
}

export function useActivity(limit = 20) {
  // Cache key MUST include the active project selection — otherwise
  // react-query reuses the same cache entry across project switches and
  // shows stale cross-project activity until the next refetch tick.
  const queryKey = useProjectScopedQueryKey(['activity', limit]);
  return usePowerQuery<ActivityEvent[]>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<ActivityEvent[]>(`/activity?limit=${limit}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
