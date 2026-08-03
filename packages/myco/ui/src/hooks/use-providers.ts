import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchJson, putJson, postJson } from '../lib/api';
import { useProjectScopedQueryKey } from './use-project-selection';
import { useIsTeamConfigTarget, useTeamConfigTargetOrNull, teamCarrierHeaders } from './use-scoped-config';
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
  return (KNOWN_HARNESS_IDS as readonly string[]).includes(value) ? (value as HarnessIdUi) : '';
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

/* ---------- Task execution inheritance ---------- */

/** Resolve effective execution config from task fields. */
export interface TaskExecutionSource {
  execution?: {
    harness?: string;
    provider?: { type?: string };
    model?: string;
    reasoningLevel?: 'low' | 'default' | 'high';
    maxTurns?: number;
    timeoutSeconds?: number;
  };
  model?: string;
  reasoningLevel?: 'low' | 'default' | 'high';
  maxTurns?: number;
  timeoutSeconds?: number;
}

export interface ExecutionSummary {
  harness?: string;
  provider?: string;
  model?: string;
  reasoningLevel?: 'low' | 'default' | 'high';
  maxTurns?: number;
  timeoutSeconds?: number;
}

export interface InheritedExecutionSummary extends ExecutionSummary {
  providerType?: string;
  localBackend?: 'ollama' | 'lmstudio';
  reasoningMap?: Partial<Record<'low' | 'default' | 'high', string>>;
  baseUrl?: string;
  contextLength?: number;
}

/** A task's OWN execution fields, ignoring anything inherited. Used for the
 *  "Task Definition" summary card (`TaskDetail`). */
export function getExecution(task: TaskExecutionSource): ExecutionSummary {
  return {
    harness: task.execution?.harness,
    provider: task.execution?.provider?.type,
    model: task.execution?.model ?? task.model,
    reasoningLevel: task.execution?.reasoningLevel ?? task.reasoningLevel,
    maxTurns: task.execution?.maxTurns ?? task.maxTurns,
    timeoutSeconds: task.execution?.timeoutSeconds ?? task.timeoutSeconds,
  };
}

/** A task's execution config resolved against the global provider default —
 *  the placeholder/inherited-default view `TaskProviderConfig`'s `defaults`
 *  prop needs. Shared by `TaskDetail` (project-scoped) and
 *  `TeamTaskProviderConfig` (Team settings per-task table, server-mode
 *  design spec §6.3) so both compute the SAME inherited-defaults view
 *  without forking the logic. */
export function getInheritedExecution(
  task: {
    execution?: {
      harness?: string;
      provider?: {
        type?: string;
        local_backend?: 'ollama' | 'lmstudio';
        model?: string;
        reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
        base_url?: string;
        context_length?: number;
      };
      model?: string;
      reasoningLevel?: 'low' | 'default' | 'high';
      maxTurns?: number;
      timeoutSeconds?: number;
    };
    model?: string;
    reasoningLevel?: 'low' | 'default' | 'high';
    maxTurns?: number;
    timeoutSeconds?: number;
  },
  config: {
    agent?: {
      harness?: string;
      provider?: {
        type?: string;
        local_backend?: 'ollama' | 'lmstudio';
        model?: string;
        reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
        base_url?: string;
        context_length?: number;
      };
    };
  } | undefined,
): InheritedExecutionSummary {
  const globalProvider = config?.agent?.provider;
  const taskProvider = task.execution?.provider;
  const taskProviderType = taskProvider?.type ? parseProviderType(taskProvider.type) || undefined : undefined;
  const globalProviderType = globalProvider?.type ? parseProviderType(globalProvider.type) || undefined : undefined;
  const reasoningLevel = task.execution?.reasoningLevel ?? task.reasoningLevel;
  const fallbackModel = task.execution?.model ?? task.model ?? globalProvider?.model;
  return {
    harness: task.execution?.harness
      ?? config?.agent?.harness
      ?? maybeInferHarnessFromProviderType(taskProviderType)
      ?? maybeInferHarnessFromProviderType(globalProviderType),
    providerType: taskProvider?.type ?? globalProvider?.type,
    localBackend: taskProvider?.local_backend ?? globalProvider?.local_backend,
    reasoningLevel,
    model: resolveReasoningModel(reasoningLevel, taskProvider ?? globalProvider, fallbackModel),
    reasoningMap: taskProvider?.reasoning_map ?? globalProvider?.reasoning_map,
    baseUrl: taskProvider?.base_url ?? globalProvider?.base_url,
    contextLength: taskProvider?.context_length ?? globalProvider?.context_length,
    maxTurns: task.execution?.maxTurns ?? task.maxTurns,
    timeoutSeconds: task.execution?.timeoutSeconds ?? task.timeoutSeconds,
  };
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

/** Fetch the current config override for a task from myco.yaml — or, when
 *  rendered inside a `TeamConfigTargetProvider` (the Team settings per-task
 *  table, server-mode design spec §6.3), the served grove's team-write
 *  counterpart route instead. `TaskProviderConfig` itself is unmodified;
 *  only this hook and `useUpdateTaskConfig` below branch on the target. */
export function useTaskConfig(taskId: string | undefined) {
  const isTeam = useIsTeamConfigTarget();
  const target = useTeamConfigTargetOrNull();
  const projectQueryKey = useProjectScopedQueryKey(['task-config', taskId]);
  // Keyed by the TARGET too (review C7): the selector switch remounts the
  // panel but not the cache — an unscoped key showed host A's overrides
  // while bound to host B for a staleTime window, and a save wrote them.
  const teamQueryKey = ['team-task-config', target?.carrier?.hostId ?? 'self', taskId];
  const headers = useMemo(
    () => (isTeam && target ? teamCarrierHeaders(target) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTeam, target?.carrier?.hostId],
  );
  const path = isTeam ? `/team/agent-tasks/${taskId}/config` : `/agent/tasks/${taskId}/config`;
  return useQuery<TaskConfigResponse>({
    queryKey: isTeam ? teamQueryKey : projectQueryKey,
    queryFn: ({ signal }) => fetchJson<TaskConfigResponse>(path, { signal, headers }),
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

/** Update a task's config override in myco.yaml — or, bound to a team target
 *  (see `useTaskConfig` above), the served grove's `agent.tasks.<id>`
 *  override via the team-write route. Accepts partial updates. */
export function useUpdateTaskConfig() {
  const queryClient = useQueryClient();
  const isTeam = useIsTeamConfigTarget();
  const target = useTeamConfigTargetOrNull();
  const headers = useMemo(
    () => (isTeam && target ? teamCarrierHeaders(target) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isTeam, target?.carrier?.hostId],
  );
  return useMutation<{ taskId: string; config: TaskConfigOverride | null }, Error, UpdateTaskConfigPayload>({
    mutationFn: ({ taskId, config }) => {
      const path = isTeam ? `/team/agent-tasks/${taskId}/config` : `/agent/tasks/${taskId}/config`;
      return putJson<{ taskId: string; config: TaskConfigOverride | null }>(path, config, { headers });
    },
    onSuccess: (_data, variables) => {
      const queryKey = isTeam ? ['team-task-config', variables.taskId] : ['task-config', variables.taskId];
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
