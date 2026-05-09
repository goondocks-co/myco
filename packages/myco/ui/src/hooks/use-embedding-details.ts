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

/**
 * `scope='project'` narrows the counts to the request context's
 * project_id (default). `scope='grove'` returns Grove-wide totals
 * (no project filter — every project in the active Grove DB).
 * `scope='all-groves'` is not yet supported by the server; callers
 * map it to 'grove' for now.
 */
export type EmbeddingDetailsScope = 'project' | 'grove' | 'all-groves';

export function useEmbeddingDetails(scope: EmbeddingDetailsScope = 'project') {
  // Treat all-groves as Grove for the active Grove until the server
  // supports cross-Grove fan-out for this endpoint.
  const wireScope = scope === 'all-groves' ? 'grove' : scope;
  return usePowerQuery<EmbeddingDetails>({
    queryKey: ['embedding-details', wireScope],
    queryFn: ({ signal }) =>
      fetchJson<EmbeddingDetails>(`/embedding/details?scope=${wireScope}`, { signal }),
    refetchInterval: POLL_INTERVALS.STATS,
    pollCategory: 'standard',
  });
}
