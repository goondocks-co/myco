import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { GrovesResponse } from '../lib/selection';

export function useGroves(options: { includeArchived?: boolean; refetchInterval?: number } = {}) {
  const includeArchived = options.includeArchived ?? false;
  return useQuery({
    queryKey: ['groves', { includeArchived }],
    queryFn: ({ signal }) =>
      fetchJson<GrovesResponse>(includeArchived ? '/groves?include_archived=true' : '/groves', { signal }),
    staleTime: 5_000,
    // Opt-in polling — the onboarding screen passes an interval so it can
    // advance into a project's dashboard the moment the first hook registers
    // one, without the user reloading.
    refetchInterval: options.refetchInterval,
  });
}
