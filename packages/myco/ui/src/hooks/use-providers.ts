import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for provider detection (30 seconds — providers don't change often). */
const PROVIDERS_STALE_TIME = 30_000;

/* ---------- Types ---------- */

export interface ProviderInfo {
  type: 'anthropic' | 'ollama' | 'lmstudio';
  available: boolean;
  baseUrl?: string;
  models: string[];
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ProviderConfig {
  type: 'anthropic' | 'ollama' | 'lmstudio';
  model?: string;
  base_url?: string;
  context_length?: number;
}

export interface PhaseOverride {
  provider?: ProviderConfig;
  model?: string;
  maxTurns?: number;
}

export interface ScheduleOverride {
  enabled?: boolean;
  intervalSeconds?: number;
  runIn?: ('active' | 'idle' | 'sleep')[];
  preCondition?: 'has-unprocessed-batches' | 'has-active-skills';
}

export interface TaskConfigOverride {
  provider?: ProviderConfig;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  phases?: Record<string, PhaseOverride>;
  schedule?: ScheduleOverride;
  params?: Record<string, string | number | boolean>;
}

/** Form-state shape for editing a provider in the UI — string values for
 *  number fields so HTML number inputs bind cleanly without empty-state
 *  flicker. Used by both the global Agent Provider card and per-task
 *  TaskProviderConfig. */
export interface ProviderDraft {
  type: ProviderConfig['type'] | '';
  model: string;
  baseUrl: string;
  contextLength: string;
}

/** Seed a draft from a freshly-selected provider type — picks the first
 *  available model and the provider's default base URL. Both the global
 *  Agent card and per-task config call this on the provider-type change
 *  event; centralized so the two stay in sync. */
export function seedDraftFromProviderType(
  type: string,
  providers: ProviderInfo[],
): ProviderDraft {
  const info = providers.find((p) => p.type === type);
  return {
    type: type as ProviderConfig['type'],
    model: info?.models?.[0] ?? '',
    baseUrl: info?.baseUrl ?? '',
    contextLength: '',
  };
}

/** Build the persisted ProviderConfig from a draft. Drops empty optional
 *  fields and only includes base_url/context_length for local providers. */
export function draftToProviderConfig(draft: ProviderDraft): ProviderConfig | undefined {
  if (draft.type === '') return undefined;
  const isLocal = draft.type === 'ollama' || draft.type === 'lmstudio';
  return {
    type: draft.type,
    ...(draft.model ? { model: draft.model } : {}),
    ...(isLocal && draft.baseUrl ? { base_url: draft.baseUrl } : {}),
    ...(isLocal && draft.contextLength ? { context_length: Number(draft.contextLength) } : {}),
  };
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
