import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { usePowerQuery } from './use-power-query';

export interface ProgressState {
  status: 'running' | 'completed' | 'failed';
  percent?: number;
  message?: string;
  result?: unknown;
}

export function useProgress(token: string | null) {
  return usePowerQuery<ProgressState>({
    queryKey: ['progress', token],
    queryFn: ({ signal }) => fetchJson(`/progress/${token}`, { signal }),
    enabled: !!token,
    pollCategory: 'realtime',
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'completed' || data?.status === 'failed') return false;
      return POLL_INTERVALS.PROGRESS;
    },
  });
}
