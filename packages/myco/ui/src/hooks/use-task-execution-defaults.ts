/**
 * `useTaskExecutionDefaults` — resolves the effective task-level defaults
 * (runtime, provider, model, reasoning) and the inputs the shared provider
 * draft hook needs, in one place.
 *
 * Previously this logic lived inline in both `RunTaskDialog` and
 * `MatrixRunDialog` with a subtle discrepancy (MatrixRunDialog was missing
 * the `fromTaskRowProvider(execution?.provider)` fallback in its
 * `taskDefaultProvider` chain). Consolidating here fixes that as a side
 * effect.
 */

import { useMemo } from 'react';
import type { RuntimeId, ReasoningLevel } from '@myco/agent/types';
import type { ProviderDraftDefaults, ProviderDraftSource } from './use-provider-config-draft';
import type { TaskRow } from './use-agent';
import {
  maybeInferRuntimeFromProviderType,
  parseProviderType,
  resolveReasoningModel,
  useTaskConfig,
  type ProviderConfig,
} from './use-providers';
import { useScopedConfig } from './use-scoped-config';
import { useAgentTasks } from './use-agent';
import { fromTaskRowProvider } from '../components/agent/provider-coercion';

export interface TaskExecutionDefaults {
  /** The task row the defaults were resolved from, when still known. */
  taskRow: TaskRow | undefined;
  /** Resolved runtime — always present (falls back to `claude-sdk`). */
  runtime: RuntimeId;
  /** Resolved provider config, when any override chain produced one. */
  provider: ProviderConfig | undefined;
  /** Provider type short name — always present (falls back to `anthropic`). */
  providerType: string;
  /** Last-resort model name, used when no reasoning-map entry applies. */
  modelFallback: string | undefined;
  /** Reasoning level the task is configured to use by default. */
  reasoning: ReasoningLevel | undefined;
  /** Fully-resolved model string (reasoning-map aware) for the task default. */
  resolvedModel: string;
  /** Source object suitable for `useProviderConfigDraft({ source })`. */
  draftSource: ProviderDraftSource;
  /** Defaults object suitable for `useProviderConfigDraft({ defaults })`. */
  draftDefaults: ProviderDraftDefaults;
}

/**
 * Resolve the default provider/runtime/model chain for a given task name.
 * Returns `undefined` while task / global config data is still loading —
 * callers typically render a loading state in that case (as both dialogs
 * already do today).
 */
export function useTaskExecutionDefaults(
  taskName: string | undefined,
): TaskExecutionDefaults {
  const { data: tasksData } = useAgentTasks();
  const availableTasks: TaskRow[] = tasksData?.tasks ?? [];
  const taskRow = taskName
    ? availableTasks.find((t) => t.name === taskName)
    : undefined;

  const { effective } = useScopedConfig();
  const globalProvider = effective?.agent?.provider;
  const globalProviderType = globalProvider?.type
    ? parseProviderType(globalProvider.type) || undefined
    : undefined;
  const globalRuntime = globalProvider?.runtime;

  const { data: taskConfigData } = useTaskConfig(taskName);
  const taskConfig = taskConfigData?.config;
  const execution = taskRow?.execution;
  const executionProviderType = execution?.provider?.type
    ? parseProviderType(execution.provider.type) || undefined
    : undefined;

  const runtime: RuntimeId = (taskConfig?.runtime
    ?? taskConfig?.provider?.runtime
    ?? maybeInferRuntimeFromProviderType(taskConfig?.provider?.type)
    ?? execution?.runtime
    ?? maybeInferRuntimeFromProviderType(executionProviderType)
    ?? globalRuntime
    ?? maybeInferRuntimeFromProviderType(globalProviderType)
    ?? effective?.agent?.runtime
    ?? 'claude-sdk') as RuntimeId;

  const reasoning: ReasoningLevel | undefined =
    execution?.reasoningLevel ?? taskRow?.reasoningLevel;

  const provider: ProviderConfig | undefined =
    (taskConfig?.provider as ProviderConfig | undefined)
    ?? fromTaskRowProvider(execution?.provider)
    ?? (globalProvider as ProviderConfig | undefined);

  const providerType = provider?.type ?? 'anthropic';

  const modelFallback = taskConfig?.provider?.model
    ?? taskConfig?.model
    ?? execution?.model
    ?? taskRow?.model
    ?? globalProvider?.model;

  const resolvedModel = resolveReasoningModel(reasoning, provider, modelFallback);

  const draftSource: ProviderDraftSource = useMemo(
    () => ({
      runtime: taskConfig?.runtime ?? execution?.runtime,
      provider,
      model: modelFallback,
    }),
    [taskConfig?.runtime, execution?.runtime, provider, modelFallback],
  );

  const draftDefaults: ProviderDraftDefaults = {
    runtime,
    providerType,
    localBackend: provider?.local_backend,
    model: modelFallback,
    reasoningMap: provider?.reasoning_map,
    baseUrl: provider?.base_url,
    contextLength: provider?.context_length,
  };

  return {
    taskRow,
    runtime,
    provider,
    providerType,
    modelFallback,
    reasoning,
    resolvedModel,
    draftSource,
    draftDefaults,
  };
}
