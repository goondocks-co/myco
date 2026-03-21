import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

interface ModelsResponse {
  provider: string;
  models: string[];
}

const MODELS_STALE_TIME = 30_000; // Cache for 30 seconds

/** Providers that require a base_url before we can fetch models. */
const REQUIRES_BASE_URL = new Set(['openai-compatible']);

export function useModels(provider: string | null, baseUrl?: string | null) {
  // Don't fetch if provider needs a base_url and none is provided
  const needsUrl = provider ? REQUIRES_BASE_URL.has(provider) : false;
  const canFetch = !!provider && (!needsUrl || !!baseUrl);

  return useQuery<ModelsResponse>({
    queryKey: ['models', provider, baseUrl],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ provider: provider! });
      if (baseUrl) params.set('base_url', baseUrl);
      return fetchJson<ModelsResponse>(`/models?${params.toString()}`, { signal });
    },
    enabled: canFetch,
    staleTime: MODELS_STALE_TIME,
  });
}
