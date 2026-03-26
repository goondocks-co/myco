import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for provider detection (30 seconds — providers don't change often). */
const PROVIDERS_STALE_TIME = 30_000;

/* ---------- Types ---------- */

export interface ProviderInfo {
  type: 'cloud' | 'ollama' | 'lmstudio';
  available: boolean;
  baseUrl?: string;
  models: string[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ProviderConfig {
  type: 'cloud' | 'ollama' | 'lmstudio';
  model?: string;
  base_url?: string;
  context_length?: number;
}

export interface PhaseOverride {
  provider?: ProviderConfig;
  model?: string;
  maxTurns?: number;
}

export interface TaskConfigOverride {
  provider?: ProviderConfig;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  phases?: Record<string, PhaseOverride>;
}

export interface TaskConfigResponse {
  taskId: string;
  config: TaskConfigOverride | null;
}

export interface TestProviderResponse {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface UpdateTaskConfigPayload {
  taskId: string;
  config: Partial<TaskConfigOverride> & { [key: string]: unknown };
}

/* ---------- Hooks ---------- */

/** Fetch the current config override for a task from myco.yaml. */
export function useTaskConfig(taskId: string | undefined) {
  return useQuery<TaskConfigResponse>({
    queryKey: ['task-config', taskId],
    queryFn: ({ signal }) => fetchJson<TaskConfigResponse>(`/agent/tasks/${taskId}/config`, { signal }),
    enabled: taskId !== undefined,
    staleTime: PROVIDERS_STALE_TIME,
  });
}

/** Fetch available providers and their models. */
export function useProviders() {
  return useQuery<ProvidersResponse>({
    queryKey: ['providers'],
    queryFn: ({ signal }) => fetchJson<ProvidersResponse>('/providers', { signal }),
    staleTime: PROVIDERS_STALE_TIME,
  });
}

/** Test connectivity to a specific provider. */
export function useTestProvider() {
  return useMutation<TestProviderResponse, Error, ProviderConfig>({
    mutationFn: (config) => postJson<TestProviderResponse>('/providers/test', config),
  });
}

/** Update a task's config override in myco.yaml. Accepts partial updates. */
export function useUpdateTaskConfig() {
  const queryClient = useQueryClient();
  return useMutation<{ taskId: string; config: TaskConfigOverride | null }, Error, UpdateTaskConfigPayload>({
    mutationFn: ({ taskId, config }) =>
      putJson<{ taskId: string; config: TaskConfigOverride | null }>(`/agent/tasks/${taskId}/config`, config),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['task-config', variables.taskId] });
    },
  });
}
