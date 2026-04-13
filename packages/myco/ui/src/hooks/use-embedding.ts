import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface EmbeddingStatusResponse {
  provider: string;
  model: string;
  status: 'idle' | 'pending' | 'unavailable';
  queue_depth: number;
  embedded_count: number;
  total_embeddable: number;
}

export function useEmbeddingStatus() {
  return usePowerQuery<EmbeddingStatusResponse>({
    queryKey: ['embedding-status'],
    queryFn: ({ signal }) =>
      fetchJson<EmbeddingStatusResponse>('/embedding/status', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
