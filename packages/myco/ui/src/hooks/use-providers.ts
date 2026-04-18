import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson } from '../lib/api';

/* ---------- Constants ---------- */

/** Cache TTL for provider detection (30 seconds — providers don't change often). */
const PROVIDERS_STALE_TIME = 30_000;

/* ---------- Types ---------- */

export interface ProviderInfo {
  type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
  runtime: 'claude-sdk' | 'openai-agents';
  available: boolean;
  authConfigured?: boolean;
  baseUrl?: string;
  models: string[];
}

export type RuntimeIdUi = ProviderInfo['runtime'];
export type ProviderTypeUi = ProviderInfo['type'];

const RUNTIME_IDS: readonly RuntimeIdUi[] = ['claude-sdk', 'openai-agents'];
const PROVIDER_TYPES_UI: readonly ProviderTypeUi[] = [
  'anthropic',
  'ollama',
  'lmstudio',
  'openai',
  'openrouter',
  'openai-compatible',
];

/**
 * Narrow an arbitrary string to RuntimeIdUi. Returns '' when the input
 * isn't a known runtime id — callers can then treat '' as "no runtime
 * selected" without blanket casting.
 */
export function parseRuntimeId(value: string): RuntimeIdUi | '' {
  return (RUNTIME_IDS as readonly string[]).includes(value) ? (value as RuntimeIdUi) : '';
}

/**
 * Narrow an arbitrary string to ProviderTypeUi. Returns '' when the input
 * isn't a known provider type.
 */
export function parseProviderType(value: string): ProviderTypeUi | '' {
  return (PROVIDER_TYPES_UI as readonly string[]).includes(value) ? (value as ProviderTypeUi) : '';
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ProviderConfig {
  runtime?: 'claude-sdk' | 'openai-agents';
  type: ProviderInfo['type'];
  local_backend?: 'ollama' | 'lmstudio';
  model?: string;
  reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
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
  runtime?: 'claude-sdk' | 'openai-agents';
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
  runtime: ProviderConfig['runtime'] | '';
  type: ProviderConfig['type'] | '';
  localBackend: ProviderConfig['local_backend'] | '';
  model: string;
  reasoningLow: string;
  reasoningDefault: string;
  reasoningHigh: string;
  baseUrl: string;
  contextLength: string;
}

// Canonical defaults live server-side (OllamaBackend.DEFAULT_BASE_URL,
// LmStudioBackend.DEFAULT_BASE_URL). Mirrored here so the UI can suggest
// a default without waiting for the /providers round trip when the user
// switches local_backend. Keep in sync with the server constants.
export const LOCAL_BACKEND_DEFAULT_BASE_URLS = {
  ollama: 'http://localhost:11434',
  lmstudio: 'http://localhost:1234',
} as const;

export function defaultBaseUrlForProvider(
  type: ProviderDraft['type'] | undefined,
  localBackend: ProviderDraft['localBackend'] | undefined,
  fallbackBaseUrl?: string,
): string {
  if (type === 'openai-compatible' && localBackend) {
    return LOCAL_BACKEND_DEFAULT_BASE_URLS[localBackend];
  }
  return fallbackBaseUrl ?? '';
}

const PROVIDER_RUNTIME_BY_TYPE: Record<ProviderInfo['type'], ProviderInfo['runtime']> = {
  anthropic: 'claude-sdk',
  ollama: 'claude-sdk',
  lmstudio: 'claude-sdk',
  openai: 'openai-agents',
  openrouter: 'openai-agents',
  'openai-compatible': 'openai-agents',
};

export function inferRuntimeFromProviderType(
  type: ProviderDraft['type'] | undefined,
): ProviderDraft['runtime'] | '' {
  if (!type) return '';
  return PROVIDER_RUNTIME_BY_TYPE[type];
}

export function maybeInferRuntimeFromProviderType(
  type: ProviderDraft['type'] | undefined,
): ProviderDraft['runtime'] | undefined {
  const runtime = inferRuntimeFromProviderType(type);
  return runtime || undefined;
}

const PROVIDER_RUNTIME_SUPPORT: Record<ProviderInfo['type'], Array<ProviderInfo['runtime']>> = {
  anthropic: ['claude-sdk'],
  ollama: ['claude-sdk', 'openai-agents'],
  lmstudio: ['claude-sdk', 'openai-agents'],
  openai: ['openai-agents'],
  openrouter: ['openai-agents'],
  'openai-compatible': ['openai-agents'],
};

export function providerSupportsRuntime(
  type: ProviderDraft['type'] | undefined,
  runtime: ProviderDraft['runtime'] | '' | undefined,
): boolean {
  if (!type || !runtime) return false;
  return PROVIDER_RUNTIME_SUPPORT[type]?.includes(runtime) ?? false;
}

export function resolveReasoningModel(
  reasoningLevel: 'low' | 'default' | 'high' | undefined,
  provider: {
    model?: string;
    reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
  } | undefined,
  fallbackModel: string | undefined,
): string {
  const level = reasoningLevel ?? 'default';
  return provider?.reasoning_map?.[level]
    ?? provider?.model
    ?? fallbackModel
    ?? '';
}

/** Seed a draft from a freshly-selected provider type — picks the first
 *  available model and the provider's default base URL. Both the global
 *  Agent card and per-task config call this on the provider-type change
 *  event; centralized so the two stay in sync. */
export function seedDraftFromProviderType(
  type: string,
  providers: ProviderInfo[],
  runtimeOverride?: ProviderDraft['runtime'],
): ProviderDraft {
  const info = providers.find((p) => p.type === type);
  const modelSet = new Set(info?.models ?? []);
  const defaultModel = info?.models?.[0] ?? '';
  const pick = (...patterns: string[]) =>
    info?.models?.find((model) => patterns.some((pattern) => model.includes(pattern))) ?? '';
  const pickExact = (candidate: string) =>
    info?.models?.find((model) => model === candidate) ?? '';
  return {
    runtime: runtimeOverride && providerSupportsRuntime(type as ProviderDraft['type'], runtimeOverride)
      ? runtimeOverride
      : info?.runtime ?? inferRuntimeFromProviderType(type as ProviderDraft['type']),
    type: type as ProviderConfig['type'],
    localBackend: '',
    model: defaultModel,
    reasoningLow: modelSet.size > 0
      ? (
        (type === 'anthropic' ? pick('haiku')
          : type === 'openai' ? pick('nano')
          : defaultModel)
      )
      : '',
    reasoningDefault: modelSet.size > 0
      ? (
        (type === 'anthropic' ? pick('sonnet')
          : type === 'openai' ? pick('mini')
          : defaultModel)
      ) || defaultModel
      : '',
    reasoningHigh: modelSet.size > 0
      ? (
        (type === 'anthropic' ? pick('opus')
          : type === 'openai' ? pickExact('gpt-5.4')
          : '')
      )
      : '',
    baseUrl: info?.baseUrl ?? '',
    contextLength: '',
  };
}

/** Build the persisted ProviderConfig from a draft. Drops empty optional
 *  fields and only includes base_url/context_length for local providers. */
export function draftToProviderConfig(draft: ProviderDraft): ProviderConfig | undefined {
  if (draft.type === '') return undefined;
  const isLocal = draft.type === 'ollama' || draft.type === 'lmstudio' || draft.type === 'openai-compatible';
  const reasoningMap = {
    ...(draft.reasoningLow ? { low: draft.reasoningLow } : {}),
    ...(draft.reasoningDefault ? { default: draft.reasoningDefault } : {}),
    ...(draft.reasoningHigh ? { high: draft.reasoningHigh } : {}),
  };
  return {
    ...(draft.runtime ? { runtime: draft.runtime } : {}),
    type: draft.type,
    ...(draft.type === 'openai-compatible' && draft.localBackend ? { local_backend: draft.localBackend } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(Object.keys(reasoningMap).length > 0 ? { reasoning_map: reasoningMap } : {}),
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

/** Patch shape: each field is optional and may be `null` to clear the override. */
export type TaskConfigPatch = {
  [K in keyof TaskConfigOverride]?: TaskConfigOverride[K] | null;
};

export interface UpdateTaskConfigPayload {
  taskId: string;
  config: TaskConfigPatch;
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
