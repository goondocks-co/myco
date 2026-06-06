import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson } from '../lib/api';
import { useProjectScopedQueryKey } from './use-project-selection';
import {
  PROVIDER_METADATA_BY_TYPE,
  getSupportedHarnessesForProviderType,
  inferHarnessFromProviderType as inferHarnessFromProviderTypeServer,
  providerTypeSupportsHarness,
} from '@myco/agent/provider-harness';
import { PROVIDER_TYPES, type HarnessId, type ProviderType } from '@myco/agent/types';

/* ---------- Constants ---------- */

/** Cache TTL for provider detection (30 seconds — providers don't change often). */
const PROVIDERS_STALE_TIME = 30_000;

/* ---------- Types ---------- */

export interface ProviderInfo {
  type: ProviderType;
  harness: HarnessId;
  /** Every harness this provider type can run on. Server-supplied; falls
   *  back to the canonical metadata if an older daemon omits the field. */
  availableHarnesses?: readonly HarnessId[];
  available: boolean;
  authConfigured?: boolean;
  baseUrl?: string;
  models: string[];
}

export type HarnessIdUi = HarnessId;
export type ProviderTypeUi = ProviderType;

/** Closed set of harness ids the canonical metadata knows about. Derived
 *  rather than hand-maintained — adding PI-Core to PROVIDER_METADATA_BY_TYPE
 *  flows through to UI narrowing without a UI edit. */
const KNOWN_HARNESS_IDS: readonly HarnessId[] = Array.from(
  new Set(
    Object.values(PROVIDER_METADATA_BY_TYPE).flatMap((meta) => meta.supportedHarnesses),
  ),
);

/**
 * Narrow an arbitrary string to a known HarnessId. Returns '' when the
 * input isn't a known harness id — callers can then treat '' as "no
 * harness selected" without blanket casting.
 */
export function parseHarnessId(value: string): HarnessIdUi | '' {
  return KNOWN_HARNESS_IDS.includes(value) ? (value as HarnessIdUi) : '';
}

/**
 * Narrow an arbitrary string to ProviderTypeUi. Returns '' when the input
 * isn't a known provider type.
 */
export function parseProviderType(value: string): ProviderTypeUi | '' {
  return (PROVIDER_TYPES as readonly string[]).includes(value) ? (value as ProviderTypeUi) : '';
}

export interface ProvidersResponse {
  providers: ProviderInfo[];
}

export interface ProviderConfig {
  type: ProviderInfo['type'];
  local_backend?: 'ollama' | 'lmstudio';
  model?: string;
  reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
  base_url?: string;
  context_length?: number;
}

export type ReasoningLevelUi = 'low' | 'default' | 'high';

/** Canonical ordered reasoning tiers (low → default → high). The single
 *  source of truth for every UI Select / option list — import this instead of
 *  re-spelling the literal so the order and membership stay consistent. */
export const REASONING_LEVELS: readonly ReasoningLevelUi[] = ['low', 'default', 'high'];

export interface PhaseOverride {
  provider?: ProviderConfig;
  /**
   * Tier override — preferred over `model` for tier-class changes.
   * Resolves through the provider's reasoning_map at execution time,
   * so a future model swap (sonnet 4.6 → 4.7) propagates automatically.
   */
  reasoningLevel?: ReasoningLevelUi;
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
  harness?: HarnessId;
  provider?: ProviderConfig;
  /** Task default reasoning tier — resolves through the provider's reasoning_map. */
  reasoningLevel?: ReasoningLevelUi;
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
  harness: HarnessIdUi | '';
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

export function inferHarnessFromProviderType(
  type: ProviderDraft['type'] | undefined,
): ProviderDraft['harness'] | '' {
  if (!type) return '';
  return inferHarnessFromProviderTypeServer(type) ?? '';
}

export function maybeInferHarnessFromProviderType(
  type: ProviderDraft['type'] | undefined,
): ProviderDraft['harness'] | undefined {
  return type ? inferHarnessFromProviderTypeServer(type) : undefined;
}

export function providerSupportsHarness(
  type: ProviderDraft['type'] | undefined,
  harness: ProviderDraft['harness'] | '' | undefined,
): boolean {
  return providerTypeSupportsHarness(
    type || undefined,
    harness || undefined,
  );
}

/** Resolve the supported harnesses for a provider type, preferring the
 *  server-supplied list on a ProviderInfo (so a future server can extend
 *  the set without a UI redeploy) and falling back to the canonical
 *  metadata bundled with the UI. */
export function supportedHarnessesForProviderInfo(
  info: ProviderInfo | undefined,
): readonly HarnessId[] {
  if (info?.availableHarnesses && info.availableHarnesses.length > 0) {
    return info.availableHarnesses;
  }
  return getSupportedHarnessesForProviderType(info?.type);
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
  harnessOverride?: ProviderDraft['harness'],
): ProviderDraft {
  const info = providers.find((p) => p.type === type);
  const modelSet = new Set(info?.models ?? []);
  const defaultModel = info?.models?.[0] ?? '';
  const pick = (...patterns: string[]) =>
    info?.models?.find((model) => patterns.some((pattern) => model.includes(pattern))) ?? '';
  const pickExact = (candidate: string) =>
    info?.models?.find((model) => model === candidate) ?? '';
  return {
    harness: harnessOverride && providerSupportsHarness(type as ProviderDraft['type'], harnessOverride)
      ? harnessOverride
      : info?.harness ?? inferHarnessFromProviderType(type as ProviderDraft['type']),
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
  capability: string | null;
  capabilityEnabled: boolean;
  effectiveScheduleEnabled: boolean;
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
  const queryKey = useProjectScopedQueryKey(['task-config', taskId]);
  return useQuery<TaskConfigResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<TaskConfigResponse>(`/agent/tasks/${taskId}/config`, { signal }),
    enabled: taskId !== undefined,
    staleTime: PROVIDERS_STALE_TIME,
  });
}

/** Fetch available providers and their models. */
export function useProviders() {
  const queryKey = useProjectScopedQueryKey(['providers']);
  return useQuery<ProvidersResponse>({
    queryKey,
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
