import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteJson, fetchJson, putJson } from '../lib/api';

const PROVIDER_SECRETS_QUERY_KEY = ['provider-secrets'] as const;
const PROVIDERS_QUERY_KEY = ['providers'] as const;
const MODELS_QUERY_KEY = ['models'] as const;

export type SecretProvider = 'openai' | 'openrouter';

export interface ProviderSecretInfo {
  configured: boolean;
  envKey: string;
  maskedValue: string | null;
  source: 'vault' | 'env' | 'none';
}

export interface ProviderSecretsResponse {
  secrets: Record<SecretProvider, ProviderSecretInfo>;
}

export function useProviderSecrets() {
  return useQuery<ProviderSecretsResponse>({
    queryKey: PROVIDER_SECRETS_QUERY_KEY,
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
    mutationFn: ({ provider, apiKey }: { provider: SecretProvider; apiKey: string }) =>
      putJson(`/providers/secrets/${provider}`, { api_key: apiKey }),
    onSuccess: () => invalidateProviderQueries(queryClient),
  });
}

export function useDeleteProviderSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: SecretProvider) => deleteJson(`/providers/secrets/${provider}`),
    onSuccess: () => invalidateProviderQueries(queryClient),
  });
}
