import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import type { GrovesResponse } from '../lib/selection';

export function useGroves() {
  return useQuery({
    queryKey: ['groves'],
    queryFn: ({ signal }) => fetchJson<GrovesResponse>('/groves', { signal }),
    staleTime: 5_000,
  });
}
