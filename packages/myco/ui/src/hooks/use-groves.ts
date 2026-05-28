import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { GrovesResponse } from '../lib/selection';

export function useGroves(options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? false;
  return useQuery({
    queryKey: ['groves', { includeArchived }],
    queryFn: ({ signal }) =>
      fetchJson<GrovesResponse>(includeArchived ? '/groves?include_archived=true' : '/groves', { signal }),
    staleTime: 5_000,
  });
}
