/**
 * Model picker for a selected provider. Resolves the available model list
 * (remote query, provider metadata, or manual entry for local backends) and
 * renders the appropriate input. Used inside ProviderModelSelector and, on the
 * Task Config page, as the "pin a specific model" escape hatch.
 */
import { Loader2 } from 'lucide-react';
import { Input } from '../ui/input';
import { SearchableSelect } from '../ui/searchable-select';
import { defaultBaseUrlForProvider, type ProviderInfo } from '../../hooks/use-providers';
import { useModels } from '../../hooks/use-models';

const MANUAL_MODEL_ENTRY_PROVIDERS = new Set(['ollama', 'lmstudio', 'openai-compatible']);

export interface ModelSelectFieldProps {
  providerType: string;
  localBackend?: 'ollama' | 'lmstudio' | '';
  baseUrl: string;
  model: string;
  modelPlaceholder?: string;
  providers: ProviderInfo[];
  onModelChange: (model: string) => void;
  label?: string;
}

export function ModelSelectField({
  providerType,
  localBackend = '',
  baseUrl,
  model,
  modelPlaceholder,
  providers,
  onModelChange,
  label = 'Model',
}: ModelSelectFieldProps) {
  const selectedProvider = providers.find((p) => p.type === providerType);
  const hasSelection = providerType !== '';
  const resolvedBaseUrl = baseUrl || defaultBaseUrlForProvider(providerType as 'ollama' | 'lmstudio' | 'openai-compatible' | undefined, localBackend, selectedProvider?.baseUrl);
  const modelsQuery = useModels(providerType || null, resolvedBaseUrl, 'llm', localBackend || null);
  const availableModels = modelsQuery.data?.models ?? selectedProvider?.models ?? [];
  const allowsManualModelEntry = MANUAL_MODEL_ENTRY_PROVIDERS.has(providerType);
  const shouldShowModelSelect = availableModels.length > 0;
  const isLoadingModels = modelsQuery.isPending && hasSelection;
  const needsApiKey = selectedProvider?.authConfigured === false;
  const modelEmptyState = needsApiKey
    ? 'Configure an API key to load models.'
    : selectedProvider?.available === false
      ? 'Provider unavailable.'
      : 'No models returned.';
  const modelPlaceholderText = modelPlaceholder ?? 'Select a model';

  if (!hasSelection) return null;

  return (
    <div className="space-y-1">
      <label className="font-sans text-xs text-on-surface-variant">{label}</label>
      {isLoadingModels ? (
        <div className="flex items-center gap-2 rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 text-sm text-on-surface-variant">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading models...
        </div>
      ) : shouldShowModelSelect ? (
        <SearchableSelect
          value={model}
          onValueChange={onModelChange}
          placeholder={modelPlaceholderText}
          searchPlaceholder="Search models..."
          emptyMessage="No models match that search."
          options={availableModels.map((candidate) => ({
            value: candidate,
            label: candidate,
          }))}
          sortOptions
          monospace
        />
      ) : allowsManualModelEntry ? (
        <Input
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          placeholder={selectedProvider?.available === false ? 'Provider offline' : 'Enter model name'}
          disabled={selectedProvider?.available === false}
        />
      ) : (
        <div className="rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2">
          <p className="font-sans text-sm text-on-surface-variant">{modelEmptyState}</p>
        </div>
      )}
    </div>
  );
}
