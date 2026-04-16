/**
 * Shared provider + model selector for agent provider configuration.
 * Used by both the Settings page (global agent provider) and the Agent
 * Tasks page (per-task provider override).
 */
import { Cloud, Server, Cpu, Loader2 } from 'lucide-react';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { SearchableSelect } from '../ui/searchable-select';
import { defaultBaseUrlForProvider, providerSupportsRuntime, type ProviderInfo } from '../../hooks/use-providers';
import { useModels } from '../../hooks/use-models';

const RUNTIME_LABELS: Record<string, string> = {
  'claude-sdk': 'Claude SDK',
  'openai-agents': 'OpenAI Agents',
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible',
};

const PROVIDER_ICONS: Record<string, typeof Cloud> = {
  anthropic: Cloud,
  ollama: Server,
  lmstudio: Cpu,
  openai: Cloud,
  openrouter: Cloud,
  'openai-compatible': Server,
};

const MANUAL_MODEL_ENTRY_PROVIDERS = new Set(['ollama', 'lmstudio', 'openai-compatible']);
const OPENAI_COMPATIBLE_BACKEND_OPTIONS = [
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'ollama', label: 'Ollama' },
] as const;

export interface ProviderModelSelectorProps {
  runtime: string;
  providerType: string;
  localBackend?: 'ollama' | 'lmstudio' | '';
  model: string;
  baseUrl: string;
  contextLength: string;
  modelPlaceholder?: string;
  providers: ProviderInfo[];
  isLoadingProviders: boolean;
  showRuntimeSelector?: boolean;
  onRuntimeChange: (runtime: string) => void;
  onProviderChange: (type: string) => void;
  onLocalBackendChange?: (localBackend: 'ollama' | 'lmstudio' | '') => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (url: string) => void;
  onContextLengthChange: (ctx: string) => void;
  /** Optional blur handlers — when present, callers commit text-input edits
   *  on blur rather than on every keystroke. */
  onBaseUrlBlur?: () => void;
  onContextLengthBlur?: () => void;
}

export function ProviderModelSelector({
  runtime,
  providerType,
  localBackend = '',
  model,
  baseUrl,
  contextLength,
  modelPlaceholder,
  providers,
  isLoadingProviders,
  showRuntimeSelector = true,
  onRuntimeChange,
  onProviderChange,
  onLocalBackendChange,
  onModelChange,
  onBaseUrlChange,
  onContextLengthChange,
  onBaseUrlBlur,
  onContextLengthBlur,
}: ProviderModelSelectorProps) {
  const providersForRuntime = providers.filter((provider) => providerSupportsRuntime(provider.type, runtime as 'claude-sdk' | 'openai-agents'));
  const selectedProvider = providers.find((p) => p.type === providerType);
  const isLocal = providerType === 'ollama' || providerType === 'lmstudio' || providerType === 'openai-compatible';
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

  return (
    <div className="space-y-3">
      {showRuntimeSelector && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Runtime</label>
          <Select value={runtime} onValueChange={onRuntimeChange}>
            <SelectTrigger>
              <SelectValue placeholder="Select a runtime" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RUNTIME_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Provider selector — derived from /providers response order */}
      <div className="grid grid-cols-3 gap-2">
        {providersForRuntime.map((info) => {
          const Icon = PROVIDER_ICONS[info.type];
          if (!Icon) return null;
          const isSelected = providerType === info.type;
          return (
            <button
              key={info.type}
              onClick={() => onProviderChange(info.type)}
              className={`
                flex flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 transition-colors
                ${isSelected
                  ? 'border-primary/40 bg-primary/5 text-on-surface'
                  : 'border-[var(--ghost-border)] bg-surface-container-lowest text-on-surface-variant hover:border-primary/20'
                }
              `}
            >
              <Icon className="h-4 w-4" />
              <span className="font-sans text-xs font-medium">{PROVIDER_LABELS[info.type] ?? info.type}</span>
              {!isLoadingProviders && (
                <Badge
                  variant={info.authConfigured === false || !info.available ? 'destructive' : 'secondary'}
                  className="text-[10px] px-1.5 py-0"
                >
                  {info.authConfigured === false ? 'key required' : info.available ? 'online' : 'offline'}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Base URL (local providers only) */}
      {isLocal && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Base URL</label>
          <Input
            value={baseUrl}
            onChange={(e) => onBaseUrlChange(e.target.value)}
            onBlur={onBaseUrlBlur}
            placeholder={resolvedBaseUrl}
          />
        </div>
      )}

      {providerType === 'openai-compatible' && onLocalBackendChange && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Local Backend</label>
          <Select value={localBackend || 'lmstudio'} onValueChange={(value) => onLocalBackendChange(value as 'ollama' | 'lmstudio')}>
            <SelectTrigger>
              <SelectValue placeholder="Select a backend" />
            </SelectTrigger>
            <SelectContent>
              {OPENAI_COMPATIBLE_BACKEND_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="font-sans text-[11px] text-on-surface-variant/70">
            OpenAI-compatible chat endpoints look the same, but local backends
            still need different model-loading and context handling.
          </p>
        </div>
      )}

      {/* Context length (local providers only) */}
      {isLocal && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Context Length</label>
          <Input
            type="number"
            value={contextLength}
            onChange={(e) => onContextLengthChange(e.target.value)}
            onBlur={onContextLengthBlur}
            placeholder="32768 (default)"
          />
          <p className="font-sans text-[11px] text-on-surface-variant/70">
            Leave blank to use the 32K default. Myco creates a Modelfile
            variant at this size so the model loads at the size you asked
            for, not its (much larger) native default.
          </p>
        </div>
      )}

      {/* Model selector — hidden when no provider is selected */}
      {hasSelection && (
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Model</label>
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
      )}
    </div>
  );
}
