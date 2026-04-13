/**
 * Shared provider + model selector for agent provider configuration.
 * Used by both the Settings page (global agent provider) and the Agent
 * Tasks page (per-task provider override).
 */
import { Cloud, Server, Cpu } from 'lucide-react';
import { Input } from '../ui/input';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import type { ProviderInfo } from '../../hooks/use-providers';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

const PROVIDER_ICONS: Record<string, typeof Cloud> = {
  anthropic: Cloud,
  ollama: Server,
  lmstudio: Cpu,
};

export interface ProviderModelSelectorProps {
  providerType: string;
  model: string;
  baseUrl: string;
  contextLength: string;
  modelPlaceholder?: string;
  providers: ProviderInfo[];
  isLoadingProviders: boolean;
  onProviderChange: (type: string) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (url: string) => void;
  onContextLengthChange: (ctx: string) => void;
}

export function ProviderModelSelector({
  providerType,
  model,
  baseUrl,
  contextLength,
  modelPlaceholder,
  providers,
  isLoadingProviders,
  onProviderChange,
  onModelChange,
  onBaseUrlChange,
  onContextLengthChange,
}: ProviderModelSelectorProps) {
  const selectedProvider = providers.find((p) => p.type === providerType);
  const isLocal = providerType === 'ollama' || providerType === 'lmstudio';
  const hasSelection = providerType !== '';
  const availableModels = selectedProvider?.models ?? [];

  return (
    <div className="space-y-3">
      {/* Provider selector — derived from /providers response order */}
      <div className="grid grid-cols-3 gap-2">
        {providers.map((info) => {
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
                  variant={info.available ? 'secondary' : 'destructive'}
                  className="text-[10px] px-1.5 py-0"
                >
                  {info.available ? 'online' : 'offline'}
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
            placeholder={selectedProvider?.baseUrl ?? ''}
          />
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
          {availableModels.length > 0 ? (
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger>
                <SelectValue placeholder={modelPlaceholder ?? 'Select a model'} />
              </SelectTrigger>
              <SelectContent>
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    <span className="font-mono text-sm">{m}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder={selectedProvider?.available === false ? 'Provider offline' : 'Enter model name'}
              disabled={selectedProvider?.available === false}
            />
          )}
        </div>
      )}
    </div>
  );
}
