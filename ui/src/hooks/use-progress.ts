import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface ProgressState {
  status: 'running' | 'complete' | 'failed';
  percent?: number;
  message?: string;
  result?: unknown;
}

export function useProgress(token: string | null) {
  return useQuery<ProgressState>({
    queryKey: ['progress', token],
    queryFn: ({ signal }) => fetchJson(`/progress/${token}`, { signal }),
    enabled: !!token,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'complete' || data?.status === 'failed') return false;
      return POLL_INTERVALS.PROGRESS;
    },
  });
}
