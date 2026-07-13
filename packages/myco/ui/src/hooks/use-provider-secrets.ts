import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteJson, fetchJson, putJson } from '../lib/api';
import { useProjectScopedQueryKey } from './use-project-selection';
import { teamCarrierHeaders, useTeamConfigTargetOrNull } from './use-scoped-config';

const PROVIDER_SECRETS_QUERY_KEY = ['provider-secrets'] as const;
const TEAM_PROVIDER_SECRETS_QUERY_KEY = ['team-provider-secrets'] as const;
const PROVIDERS_QUERY_KEY = ['providers'] as const;
const MODELS_QUERY_KEY = ['models'] as const;

export type SecretProvider = 'openai' | 'openrouter' | 'github';
export type SecretScope = 'machine' | 'project';
/** `'team'` — a masked value echoed by a team-write secret write (Task 8).
 *  Never a read: the served-grove secrets store is write-only, so a team
 *  secret's `configured`/`maskedValue` only ever reflects what THIS session
 *  itself just saved or deleted, not what another team member configured
 *  earlier — the panel's `keyHealth` status line carries that durable truth. */
export type SecretSource = SecretScope | 'env' | 'none' | 'team';

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

/** Read side has no team equivalent — Task 8's served-grove secrets store is
 *  write-only by design (spec §6: masked-echo-only, never a raw or even a
 *  "configured" read over the flat-trust overlay). In team mode this returns
 *  a session-local view seeded empty and populated only by THIS session's own
 *  save/delete mutations below (`onSuccess` writes straight into the query
 *  cache) — never a network read. */
export function useProviderSecrets() {
  const teamTarget = useTeamConfigTargetOrNull();
  const isTeam = teamTarget !== null;
  const queryKey = useProjectScopedQueryKey([...PROVIDER_SECRETS_QUERY_KEY]);
  const projectQuery = useQuery<ProviderSecretsResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<ProviderSecretsResponse>('/providers/secrets', { signal }),
    enabled: !isTeam,
  });
  const teamQuery = useQuery<ProviderSecretsResponse>({
    queryKey: TEAM_PROVIDER_SECRETS_QUERY_KEY,
    queryFn: () => Promise.resolve({ secrets: {} as ProviderSecretsResponse['secrets'] }),
    enabled: isTeam,
    staleTime: Infinity,
  });
  return isTeam ? teamQuery : projectQuery;
}

function invalidateProviderQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: PROVIDER_SECRETS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: PROVIDERS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
}

/** Merge a team secret write's masked-echo-only response into the session-local
 *  cache `useProviderSecrets` reads back in team mode. */
function cacheTeamSecretResult(
  queryClient: ReturnType<typeof useQueryClient>,
  provider: SecretProvider,
  maskedValue: string | null,
) {
  queryClient.setQueryData<ProviderSecretsResponse>(TEAM_PROVIDER_SECRETS_QUERY_KEY, (prev) => ({
    secrets: {
      ...(prev?.secrets ?? {}),
      [provider]: {
        configured: maskedValue !== null,
        envKey: '',
        maskedValue,
        source: 'team',
        sourceScope: null,
        defaultScope: 'project',
        availableScopes: [],
      },
    } as ProviderSecretsResponse['secrets'],
  }));
}

export function useSaveProviderSecret() {
  const queryClient = useQueryClient();
  const teamTarget = useTeamConfigTargetOrNull();
  return useMutation({
    mutationFn: ({ provider, apiKey, scope }: { provider: SecretProvider; apiKey: string; scope?: SecretScope }) =>
      teamTarget
        ? putJson<{ provider: string; maskedValue: string }>(
            `/team/secrets/${provider}`,
            { secret: apiKey },
            { headers: teamCarrierHeaders(teamTarget) },
          )
        : putJson(`/providers/secrets/${provider}`, { api_key: apiKey, scope }),
    onSuccess: (data, variables) => {
      if (teamTarget) cacheTeamSecretResult(queryClient, variables.provider, (data as { maskedValue: string }).maskedValue);
      invalidateProviderQueries(queryClient);
    },
  });
}

export function useDeleteProviderSecret() {
  const queryClient = useQueryClient();
  const teamTarget = useTeamConfigTargetOrNull();
  return useMutation({
    mutationFn: ({ provider, scope }: { provider: SecretProvider; scope?: SecretScope }) =>
      teamTarget
        ? fetchJson<{ provider: string; maskedValue: null }>(`/team/secrets/${provider}`, {
            method: 'DELETE',
            headers: teamCarrierHeaders(teamTarget),
          })
        : deleteJson(`/providers/secrets/${provider}${scope ? `?scope=${encodeURIComponent(scope)}` : ''}`),
    onSuccess: (_data, variables) => {
      if (teamTarget) cacheTeamSecretResult(queryClient, variables.provider, null);
      invalidateProviderQueries(queryClient);
    },
  });
}
