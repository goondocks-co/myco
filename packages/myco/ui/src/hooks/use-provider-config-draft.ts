import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  defaultBaseUrlForProvider,
  draftToProviderConfig,
  maybeInferRuntimeFromProviderType,
  providerSupportsRuntime,
  seedDraftFromProviderType,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderInfo,
} from './use-providers';

type ReasoningLevel = 'low' | 'default' | 'high';

export interface ProviderDraftSource {
  runtime?: string;
  model?: string;
  provider?: {
    runtime?: string;
    type?: string;
    local_backend?: 'ollama' | 'lmstudio';
    model?: string;
    reasoning_map?: Partial<Record<ReasoningLevel, string>>;
    base_url?: string;
    context_length?: number;
  };
}

export interface ProviderDraftDefaults {
  runtime?: string;
  providerType?: string;
  localBackend?: 'ollama' | 'lmstudio';
  model?: string;
  reasoningMap?: Partial<Record<ReasoningLevel, string>>;
  baseUrl?: string;
  contextLength?: number;
}

export function emptyProviderDraft(): ProviderDraft {
  return {
    runtime: '',
    type: '',
    localBackend: '',
    model: '',
    reasoningLow: '',
    reasoningDefault: '',
    reasoningHigh: '',
    baseUrl: '',
    contextLength: '',
  };
}

function runtimeFromSource(
  source: ProviderDraftSource | null | undefined,
  defaults?: ProviderDraftDefaults,
): ProviderDraft['runtime'] | '' {
  return (source?.runtime as ProviderDraft['runtime'] | undefined)
    ?? (source?.provider?.runtime as ProviderDraft['runtime'] | undefined)
    ?? maybeInferRuntimeFromProviderType(source?.provider?.type as ProviderDraft['type'] | undefined)
    ?? (defaults?.runtime as ProviderDraft['runtime'] | undefined)
    ?? maybeInferRuntimeFromProviderType(defaults?.providerType as ProviderDraft['type'] | undefined)
    ?? '';
}

export function providerDraftFromSource(
  source: ProviderDraftSource | null | undefined,
  defaults?: ProviderDraftDefaults,
): ProviderDraft {
  const providerType = (source?.provider?.type as ProviderDraft['type'] | undefined) ?? '';
  if (providerType !== '') {
    return {
      runtime: runtimeFromSource(source, defaults),
      type: providerType,
      localBackend: source?.provider?.local_backend ?? defaults?.localBackend ?? '',
      model: source?.provider?.model ?? source?.model ?? '',
      reasoningLow: source?.provider?.reasoning_map?.low ?? '',
      reasoningDefault: source?.provider?.reasoning_map?.default
        ?? source?.provider?.model
        ?? source?.model
        ?? '',
      reasoningHigh: source?.provider?.reasoning_map?.high ?? '',
      baseUrl: source?.provider?.base_url ?? '',
      contextLength: source?.provider?.context_length?.toString() ?? '',
    };
  }

  return {
    runtime: runtimeFromSource(source, defaults),
    type: (defaults?.providerType as ProviderDraft['type'] | undefined) ?? '',
    localBackend: defaults?.localBackend ?? '',
    model: source?.model ?? defaults?.model ?? '',
    reasoningLow: defaults?.reasoningMap?.low ?? '',
    reasoningDefault: defaults?.reasoningMap?.default
      ?? source?.model
      ?? defaults?.model
      ?? '',
    reasoningHigh: defaults?.reasoningMap?.high ?? '',
    baseUrl: defaults?.baseUrl ?? '',
    contextLength: defaults?.contextLength != null ? String(defaults.contextLength) : '',
  };
}

export function providerDraftsEqual(left: ProviderDraft, right: ProviderDraft): boolean {
  return left.runtime === right.runtime
    && left.type === right.type
    && left.localBackend === right.localBackend
    && left.model === right.model
    && left.reasoningLow === right.reasoningLow
    && left.reasoningDefault === right.reasoningDefault
    && left.reasoningHigh === right.reasoningHigh
    && left.baseUrl === right.baseUrl
    && left.contextLength === right.contextLength;
}

export function normalizeSelectableModel(value: string, availableModels: string[]): string {
  if (value === '' || availableModels.length === 0) {
    return value;
  }
  return availableModels.includes(value) ? value : '';
}

export function draftToNormalizedProviderConfig(
  draft: ProviderDraft,
  availableModels: string[],
): ProviderConfig | undefined {
  return draftToProviderConfig({
    ...draft,
    reasoningLow: normalizeSelectableModel(draft.reasoningLow, availableModels),
    reasoningDefault: normalizeSelectableModel(draft.reasoningDefault, availableModels),
    reasoningHigh: normalizeSelectableModel(draft.reasoningHigh, availableModels),
  });
}

function isDefaultLocalBaseUrl(value: string): boolean {
  return value === ''
    || value === defaultBaseUrlForProvider('openai-compatible', 'ollama')
    || value === defaultBaseUrlForProvider('openai-compatible', 'lmstudio');
}

function nextDraftForRuntime(runtime: string, providers: ProviderInfo[]): ProviderDraft {
  const firstProvider = providers.find((provider) => providerSupportsRuntime(provider.type, runtime as ProviderDraft['runtime']));
  if (firstProvider) {
    return seedDraftFromProviderType(firstProvider.type, providers, runtime as ProviderDraft['runtime']);
  }
  return {
    ...emptyProviderDraft(),
    runtime: runtime as ProviderDraft['runtime'],
  };
}

interface UseProviderConfigDraftOptions {
  source?: ProviderDraftSource | null;
  defaults?: ProviderDraftDefaults;
  providers: ProviderInfo[];
}

export function useProviderConfigDraft({
  source,
  defaults,
  providers,
}: UseProviderConfigDraftOptions) {
  const sourceDraft = useMemo(
    () => providerDraftFromSource(source, defaults),
    [
      source?.runtime,
      source?.model,
      source?.provider?.runtime,
      source?.provider?.type,
      source?.provider?.local_backend,
      source?.provider?.model,
      source?.provider?.reasoning_map?.low,
      source?.provider?.reasoning_map?.default,
      source?.provider?.reasoning_map?.high,
      source?.provider?.base_url,
      source?.provider?.context_length,
      defaults?.runtime,
      defaults?.providerType,
      defaults?.localBackend,
      defaults?.model,
      defaults?.reasoningMap?.low,
      defaults?.reasoningMap?.default,
      defaults?.reasoningMap?.high,
      defaults?.baseUrl,
      defaults?.contextLength,
    ],
  );
  const [savedDraft, setSavedDraft] = useState<ProviderDraft>(sourceDraft);
  const [draft, setDraft] = useState<ProviderDraft>(sourceDraft);

  useEffect(() => {
    setSavedDraft(sourceDraft);
    setDraft(sourceDraft);
  }, [sourceDraft]);

  const isDirty = !providerDraftsEqual(draft, savedDraft);

  const handleRuntimeChange = useCallback((runtime: string) => {
    setDraft((prev) => {
      if (providerSupportsRuntime(prev.type, runtime as ProviderDraft['runtime'])) {
        return { ...prev, runtime: runtime as ProviderDraft['runtime'] };
      }
      return nextDraftForRuntime(runtime, providers);
    });
  }, [providers]);

  const handleProviderChange = useCallback((type: string) => {
    setDraft((prev) => seedDraftFromProviderType(
      type,
      providers,
      providerSupportsRuntime(type as ProviderDraft['type'], prev.runtime) ? prev.runtime : undefined,
    ));
  }, [providers]);

  const handleModelChange = useCallback((model: string) => {
    setDraft((prev) => ({
      ...prev,
      model,
      reasoningDefault: prev.reasoningDefault || model,
    }));
  }, []);

  const handleLocalBackendChange = useCallback((localBackend: ProviderDraft['localBackend']) => {
    setDraft((prev) => ({
      ...prev,
      localBackend,
      ...(prev.type === 'openai-compatible' && localBackend && isDefaultLocalBaseUrl(prev.baseUrl)
        ? { baseUrl: defaultBaseUrlForProvider(prev.type, localBackend) }
        : {}),
      ...(prev.type === 'openai-compatible'
        ? {
            model: '',
            reasoningLow: '',
            reasoningDefault: '',
            reasoningHigh: '',
          }
        : {}),
    }));
  }, []);

  const handleReasoningChange = useCallback((level: ReasoningLevel, value: string) => {
    setDraft((prev) => ({
      ...prev,
      ...(level === 'low' ? { reasoningLow: value } : {}),
      ...(level === 'default' ? { reasoningDefault: value } : {}),
      ...(level === 'high' ? { reasoningHigh: value } : {}),
    }));
  }, []);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft((prev) => ({ ...prev, baseUrl }));
  }, []);

  const handleContextLengthChange = useCallback((contextLength: string) => {
    setDraft((prev) => ({ ...prev, contextLength }));
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(savedDraft);
  }, [savedDraft]);

  const commitDraft = useCallback((nextDraft?: ProviderDraft) => {
    const committedDraft = nextDraft ?? draft;
    setSavedDraft(committedDraft);
    setDraft(committedDraft);
  }, [draft]);

  const clearDraft = useCallback(() => {
    setDraft(emptyProviderDraft());
  }, []);

  return {
    draft,
    savedDraft,
    isDirty,
    setDraft,
    commitDraft,
    resetDraft,
    clearDraft,
    handleRuntimeChange,
    handleProviderChange,
    handleModelChange,
    handleLocalBackendChange,
    handleReasoningChange,
    handleBaseUrlChange,
    handleContextLengthChange,
  };
}
