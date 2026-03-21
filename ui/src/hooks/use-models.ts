import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { MODELS_STALE_TIME } from '../lib/constants';

interface ModelsResponse {
  provider: string;
  models: string[];
}

/** Providers that require a base_url before we can fetch models. */
export const REQUIRES_BASE_URL = new Set(['openai-compatible']);

export type ModelType = 'llm' | 'embedding';

export function useModels(provider: string | null, baseUrl?: string | null, type?: ModelType) {
  // Don't fetch if provider needs a base_url and none is provided
  const needsUrl = provider ? REQUIRES_BASE_URL.has(provider) : false;
  const canFetch = !!provider && (!needsUrl || !!baseUrl);

  return useQuery<ModelsResponse>({
    queryKey: ['models', provider, baseUrl, type],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ provider: provider! });
      if (baseUrl) params.set('base_url', baseUrl);
      if (type) params.set('type', type);
      return fetchJson<ModelsResponse>(`/models?${params.toString()}`, { signal });
    },
    enabled: canFetch,
    staleTime: MODELS_STALE_TIME,
  });
}
