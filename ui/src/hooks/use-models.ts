import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

interface ModelsResponse {
  provider: string;
  models: string[];
}

const MODELS_STALE_TIME = 30_000; // Cache for 30 seconds

export function useModels(provider: string | null, baseUrl?: string | null) {
  return useQuery<ModelsResponse>({
    queryKey: ['models', provider, baseUrl],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ provider: provider! });
      if (baseUrl) params.set('base_url', baseUrl);
      return fetchJson<ModelsResponse>(`/models?${params.toString()}`, { signal });
    },
    enabled: !!provider,
    staleTime: MODELS_STALE_TIME,
  });
}
