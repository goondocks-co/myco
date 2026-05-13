import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteJson, fetchJson, putJson } from '../lib/api';
import { useProjectScopedQueryKey } from './use-project-selection';

const PROVIDER_SECRETS_QUERY_KEY = ['provider-secrets'] as const;
const PROVIDERS_QUERY_KEY = ['providers'] as const;
const MODELS_QUERY_KEY = ['models'] as const;

export type SecretProvider = 'openai' | 'openrouter' | 'github';
export type SecretScope = 'machine' | 'project';
export type SecretSource = SecretScope | 'env' | 'none';

export interface ProviderSecretInfo {
  configured: boolean;
  envKey: string;
  maskedValue: string | null;
  source: SecretSource;
  sourceScope: SecretScope | null;
  defaultScope: SecretScope;
  availableScopes: SecretScope[];
}

export interface ProviderSecretsResponse {
  secrets: Record<SecretProvider, ProviderSecretInfo>;
}

export function useProviderSecrets() {
  const queryKey = useProjectScopedQueryKey([...PROVIDER_SECRETS_QUERY_KEY]);
  return useQuery<ProviderSecretsResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<ProviderSecretsResponse>('/providers/secrets', { signal }),
  });
}

function invalidateProviderQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: PROVIDER_SECRETS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: PROVIDERS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
}

export function useSaveProviderSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, apiKey, scope }: { provider: SecretProvider; apiKey: string; scope?: SecretScope }) =>
      putJson(`/providers/secrets/${provider}`, { api_key: apiKey, scope }),
    onSuccess: () => invalidateProviderQueries(queryClient),
  });
}

export function useDeleteProviderSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, scope }: { provider: SecretProvider; scope?: SecretScope }) =>
      deleteJson(`/providers/secrets/${provider}${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
    onSuccess: () => invalidateProviderQueries(queryClient),
  });
}
