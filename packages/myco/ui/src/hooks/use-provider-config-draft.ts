import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  defaultBaseUrlForProvider,
  draftToProviderConfig,
  maybeInferRuntimeFromProviderType,
  parseProviderType,
  parseRuntimeId,
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
  const sourceRuntime = source?.runtime ? parseRuntimeId(source.runtime) : '';
  if (sourceRuntime) return sourceRuntime;
  const providerRuntime = source?.provider?.runtime ? parseRuntimeId(source.provider.runtime) : '';
  if (providerRuntime) return providerRuntime;
  const inferredFromSourceType = source?.provider?.type
    ? maybeInferRuntimeFromProviderType(parseProviderType(source.provider.type) || undefined)
    : undefined;
  if (inferredFromSourceType) return inferredFromSourceType;
  const defaultRuntime = defaults?.runtime ? parseRuntimeId(defaults.runtime) : '';
  if (defaultRuntime) return defaultRuntime;
  const inferredFromDefaults = defaults?.providerType
    ? maybeInferRuntimeFromProviderType(parseProviderType(defaults.providerType) || undefined)
    : undefined;
  return inferredFromDefaults ?? '';
}

export function providerDraftFromSource(
  source: ProviderDraftSource | null | undefined,
  defaults?: ProviderDraftDefaults,
): ProviderDraft {
  const providerType = source?.provider?.type ? parseProviderType(source.provider.type) : '';
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
    type: defaults?.providerType ? parseProviderType(defaults.providerType) : '',
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
  const parsedRuntime = parseRuntimeId(runtime);
  const firstProvider = providers.find((provider) => providerSupportsRuntime(provider.type, parsedRuntime));
  if (firstProvider) {
    return seedDraftFromProviderType(firstProvider.type, providers, parsedRuntime || undefined);
  }
  return {
    ...emptyProviderDraft(),
    runtime: parsedRuntime,
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
  const savedDraftRef = useRef(savedDraft);
  savedDraftRef.current = savedDraft;

  useEffect(() => {
    setSavedDraft(sourceDraft);
    // Only overwrite the user's working draft if they haven't made edits since
    // the last sync. Otherwise a parent refetch would silently wipe in-flight
    // field changes.
    setDraft((prev) => providerDraftsEqual(prev, savedDraftRef.current) ? sourceDraft : prev);
  }, [sourceDraft]);

  const isDirty = !providerDraftsEqual(draft, savedDraft);

  const handleRuntimeChange = useCallback((runtime: string) => {
    const parsedRuntime = parseRuntimeId(runtime);
    setDraft((prev) => {
      if (providerSupportsRuntime(prev.type, parsedRuntime)) {
        return { ...prev, runtime: parsedRuntime };
      }
      return nextDraftForRuntime(runtime, providers);
    });
  }, [providers]);

  const handleProviderChange = useCallback((type: string) => {
    const parsedType = parseProviderType(type);
    setDraft((prev) => seedDraftFromProviderType(
      type,
      providers,
      providerSupportsRuntime(parsedType, prev.runtime) ? prev.runtime : undefined,
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
