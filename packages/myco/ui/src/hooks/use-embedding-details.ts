import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';

export interface EmbeddingDetails {
  total: number;
  by_namespace: Record<string, { embedded: number; stale: number }>;
  models: Record<string, number>;
  pending: Record<string, number>;
  provider: { name: string; model: string; available: boolean };
}

export function useEmbeddingDetails() {
  return usePowerQuery<EmbeddingDetails>({
    queryKey: ['embedding-details'],
    queryFn: ({ signal }) => fetchJson<EmbeddingDetails>('/embedding/details', { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
