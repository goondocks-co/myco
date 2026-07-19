import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useProjectSelection } from './use-project-selection';

export interface ActivityEvent {
  type: string;
  id: string;
  summary: string;
  timestamp: number;
}

/** Empty activity feed — the zero-state an attached project shows pre-first-capture. */
const EMPTY_ACTIVITY: ActivityEvent[] = [];

export function useActivity(limit = 20) {
  const selection = useProjectSelection();
  return resolveAttachedEmpty(
    usePowerQuery<ActivityEvent[]>({
      queryKey: ['activity', limit],
      queryFn: ({ signal }) =>
        fetchJson<ActivityEvent[]>(`/activity?limit=${limit}`, { signal }),
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : POLL_INTERVALS.STATS,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
      pollCategory: 'standard',
    }),
    selection,
    EMPTY_ACTIVITY,
  );
}
