import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { MODELS_STALE_TIME } from '../lib/constants';
import { useProjectScopedQueryKey } from './use-project-selection';

interface ModelsResponse {
  provider: string;
  models: string[];
}

/** Providers that require a base_url before we can fetch models. */
export const REQUIRES_BASE_URL = new Set(['openai-compatible']);

export type ModelType = 'llm' | 'embedding';

export function useModels(
  provider: string | null,
  baseUrl?: string | null,
  type?: ModelType,
  localBackend?: 'ollama' | 'lmstudio' | null,
) {
  // Don't fetch if provider needs a base_url and none is provided
  const needsUrl = provider ? REQUIRES_BASE_URL.has(provider) : false;
  const canFetch = !!provider && (!needsUrl || !!baseUrl);
  const queryKey = useProjectScopedQueryKey(['models', provider, baseUrl, type, localBackend]);

  return useQuery<ModelsResponse>({
    queryKey,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ provider: provider! });
      if (baseUrl) params.set('base_url', baseUrl);
      if (type) params.set('type', type);
      if (localBackend) params.set('local_backend', localBackend);
      return fetchJson<ModelsResponse>(`/models?${params.toString()}`, { signal });
    },
    enabled: canFetch,
    staleTime: MODELS_STALE_TIME,
  });
}
