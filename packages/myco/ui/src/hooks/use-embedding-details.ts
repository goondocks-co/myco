import { usePowerQuery } from './use-power-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { isAttachedTenancyPending, resolveAttachedEmpty } from '../lib/degrade';
import { useProjectSelection } from './use-project-selection';

export interface EmbeddingDetails {
  total: number;
  by_namespace: Record<string, { embedded: number; stale: number }>;
  models: Record<string, number>;
  pending: Record<string, number>;
  namespace_breakdown?: Record<string, {
    embedded: number;
    pending: number;
    stale: number;
    total: number;
  }>;
  provider: { name: string; model: string; available: boolean };
  canopy_describe?: {
    pending: number;
    undescribed: number;
    stale: number;
    stuck: number;
  };
}

/**
 * The zero-state an attached project shows before its first forwarded capture
 * registers it host-side — the BEHAVE-LIKE-LOCAL twin of the fully-zeroed
 * `/embedding/details` a brand-new local project returns (every count 0, no
 * provider resolved yet). `GET /api/embedding/details` is serve-stamped, so it
 * 404s `unknown_tenancy` for an attached pre-first-capture project; mapping that
 * to this empty shape keeps the Embedding tab on its normal zero body instead of
 * "Unable to reach daemon" + a retry/poll storm.
 */
const EMPTY_EMBEDDING_DETAILS: EmbeddingDetails = {
  total: 0,
  by_namespace: {},
  models: {},
  pending: {},
  provider: { name: '', model: '', available: false },
};

/**
 * `scope='project'` narrows the counts to the request context's
 * project_id (default). `scope='grove'` returns Grove-wide totals
 * (no project filter — every project in the active Grove DB).
 * `scope='all-groves'` is not yet supported by the server; callers
 * map it to 'grove' for now.
 */
export type EmbeddingDetailsScope = 'project' | 'grove' | 'all-groves';

export function useEmbeddingDetails(scope: EmbeddingDetailsScope = 'project') {
  const selection = useProjectSelection();
  // Treat all-groves as Grove for the active Grove until the server
  // supports cross-Grove fan-out for this endpoint.
  const wireScope = scope === 'all-groves' ? 'grove' : scope;
  return resolveAttachedEmpty(
    usePowerQuery<EmbeddingDetails>({
      queryKey: ['embedding-details', wireScope],
      queryFn: ({ signal }) =>
        fetchJson<EmbeddingDetails>(`/embedding/details?scope=${wireScope}`, { signal }),
      refetchInterval: (query) =>
        isAttachedTenancyPending(query.state.error, selection) ? false : POLL_INTERVALS.STATS,
      retry: (failureCount, err) =>
        isAttachedTenancyPending(err, selection) ? false : failureCount < 3,
      pollCategory: 'standard',
    }),
    selection,
    EMPTY_EMBEDDING_DETAILS,
  );
}
