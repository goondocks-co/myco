import { useState, useEffect } from 'react';
import { Cloud, Server, Cpu, CheckCircle2, XCircle, Loader2, Zap, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import {
  useProviders,
  useTaskConfig,
  useTestProvider,
  useUpdateTaskConfig,
  type ProviderConfig,
  type PhaseOverride,
} from '../../hooks/use-providers';
import type { PhaseDefinition } from '../../hooks/use-agent';

/* ---------- Constants ---------- */

const PROVIDER_LABELS: Record<string, string> = {
  cloud: 'Anthropic Cloud',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
};

const PROVIDER_ICONS: Record<string, typeof Cloud> = {
  cloud: Cloud,
  ollama: Server,
  lmstudio: Cpu,
};

/* ---------- Types ---------- */

interface TaskProviderConfigProps {
  taskId: string;
  phases?: PhaseDefinition[];
  defaults?: { model?: string; maxTurns?: number; timeoutSeconds?: number };
}

/* ---------- Sub-components ---------- */

/** Compact provider/model selector reused for both task-level and phase-level. */
function ProviderModelSelector({
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
}: {
  providerType: string;
  model: string;
  baseUrl: string;
  contextLength: string;
  modelPlaceholder?: string;
  providers: { type: string; available: boolean; baseUrl?: string; models: string[] }[];
  isLoadingProviders: boolean;
  onProviderChange: (type: string) => void;
  onModelChange: (model: string) => void;
  onBaseUrlChange: (url: string) => void;
  onContextLengthChange: (ctx: string) => void;
}) {
  const selectedProvider = providers.find((p) => p.type === providerType);
  const isLocal = providerType === 'ollama' || providerType === 'lmstudio';
  const availableModels = selectedProvider?.models ?? [];

  return (
    <div className="space-y-3">
      {/* Provider selector */}
      <div className="grid grid-cols-3 gap-2">
        {(['cloud', 'ollama', 'lmstudio'] as const).map((type) => {
          const Icon = PROVIDER_ICONS[type];
          const info = providers.find((p) => p.type === type);
          const isSelected = providerType === type;
          return (
            <button
              key={type}
              onClick={() => onProviderChange(type)}
              className={`
                flex flex-col items-center gap-1.5 rounded-md border px-3 py-2.5 transition-colors
                ${isSelected
                  ? 'border-primary/40 bg-primary/5 text-on-surface'
                  : 'border-[var(--ghost-border)] bg-surface-container-lowest text-on-surface-variant hover:border-primary/20'
                }
              `}
            >
              <Icon className="h-4 w-4" />
              <span className="font-sans text-xs font-medium">{PROVIDER_LABELS[type]}</span>
              {!isLoadingProviders && (
                <Badge
                  variant={info?.available ? 'secondary' : 'destructive'}
                  className="text-[10px] px-1.5 py-0"
                >
                  {info?.available ? 'online' : 'offline'}
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
            placeholder="32768"
          />
        </div>
      )}

      {/* Model selector */}
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
    </div>
  );
}

/** Per-phase config row — collapsible. */
function PhaseConfigRow({
  phase,
  override,
  taskModel,
  providers,
  isLoadingProviders,
  onChange,
}: {
  phase: PhaseDefinition;
  override: PhaseOverride;
  taskModel: string;
  providers: { type: string; available: boolean; baseUrl?: string; models: string[] }[];
  isLoadingProviders: boolean;
  onChange: (update: PhaseOverride | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverride = override.provider !== undefined || override.model !== undefined || override.maxTurns !== undefined;

  return (
    <div className="border border-[var(--ghost-border)] rounded-md">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-surface-container-low/50 transition-colors rounded-md"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 text-on-surface-variant" />}
        <span className="font-sans text-sm text-on-surface">{phase.name}</span>
        <span className="font-mono text-xs text-on-surface-variant">max {override.maxTurns ?? phase.maxTurns} turns</span>
        {hasOverride && <Badge variant="secondary" className="text-[10px] ml-auto">override</Badge>}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-[var(--ghost-border)]">
          <div className="pt-3">
            <ProviderModelSelector
              providerType={override.provider?.type ?? 'cloud'}
              model={override.provider?.model ?? override.model ?? ''}
              baseUrl={override.provider?.base_url ?? ''}
              contextLength={override.provider?.context_length != null ? String(override.provider.context_length) : ''}
              modelPlaceholder={phase.model ?? taskModel}
              providers={providers}
              isLoadingProviders={isLoadingProviders}
              onProviderChange={(type) => {
                const bp = providers.find(p => p.type === type)?.baseUrl;
                onChange({
                  ...override,
                  provider: { type: type as ProviderConfig['type'], base_url: bp },
                  model: undefined,
                });
              }}
              onModelChange={(m) => onChange({
                ...override,
                provider: override.provider ? { ...override.provider, model: m } : undefined,
                model: override.provider ? undefined : m,
              })}
              onBaseUrlChange={(url) => onChange({
                ...override,
                provider: override.provider ? { ...override.provider, base_url: url } : undefined,
              })}
              onContextLengthChange={(ctx) => onChange({
                ...override,
                provider: override.provider ? { ...override.provider, context_length: ctx ? Number(ctx) : undefined } : undefined,
              })}
            />
          </div>

          <div className="space-y-1">
            <label className="font-sans text-xs text-on-surface-variant">Max Turns</label>
            <Input
              type="number"
              value={override.maxTurns ?? ''}
              onChange={(e) => onChange({ ...override, maxTurns: e.target.value ? Number(e.target.value) : undefined })}
              placeholder={String(phase.maxTurns)}
            />
          </div>

          {hasOverride && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)} className="text-xs text-on-surface-variant">
              Clear Phase Override
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Component ---------- */

export function TaskProviderConfig({ taskId, phases, defaults }: TaskProviderConfigProps) {
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const { data: taskConfigData } = useTaskConfig(taskId);
  const testMutation = useTestProvider();
  const updateMutation = useUpdateTaskConfig();

  const currentConfig = taskConfigData?.config;

  const [providerType, setProviderType] = useState<string>('cloud');
  const [model, setModel] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [contextLength, setContextLength] = useState<string>('');
  const [maxTurns, setMaxTurns] = useState<string>('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>('');
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>({});
  const [dirty, setDirty] = useState(false);

  // Sync from myco.yaml config when it loads
  useEffect(() => {
    if (currentConfig) {
      setProviderType(currentConfig.provider?.type ?? 'cloud');
      setModel(currentConfig.provider?.model ?? currentConfig.model ?? '');
      setBaseUrl(currentConfig.provider?.base_url ?? '');
      setContextLength(currentConfig.provider?.context_length != null ? String(currentConfig.provider.context_length) : '');
      setMaxTurns(currentConfig.maxTurns != null ? String(currentConfig.maxTurns) : '');
      setTimeoutSeconds(currentConfig.timeoutSeconds != null ? String(currentConfig.timeoutSeconds) : '');
      setPhaseOverrides(currentConfig.phases ?? {});
      setDirty(false);
    }
  }, [currentConfig]);

  const providers = providersData?.providers ?? [];

  function handleProviderChange(type: string) {
    setProviderType(type);
    setModel('');
    setBaseUrl(providers.find(p => p.type === type)?.baseUrl ?? '');
    setContextLength('');
    setDirty(true);
    testMutation.reset();
  }

  function handlePhaseChange(phaseName: string, update: PhaseOverride | null) {
    setPhaseOverrides((prev) => {
      const next = { ...prev };
      if (update === null) {
        delete next[phaseName];
      } else {
        next[phaseName] = update;
      }
      return next;
    });
    setDirty(true);
  }

  function handleSave() {
    const isLocal = providerType === 'ollama' || providerType === 'lmstudio';
    const provider: ProviderConfig = {
      type: providerType as ProviderConfig['type'],
      ...(model ? { model } : {}),
      ...(isLocal && baseUrl ? { base_url: baseUrl } : {}),
      ...(isLocal && contextLength ? { context_length: Number(contextLength) } : {}),
    };

    updateMutation.mutate(
      {
        taskId,
        config: {
          provider,
          ...(maxTurns ? { maxTurns: Number(maxTurns) } : { maxTurns: null as unknown as number }),
          ...(timeoutSeconds ? { timeoutSeconds: Number(timeoutSeconds) } : { timeoutSeconds: null as unknown as number }),
          ...(Object.keys(phaseOverrides).length > 0 ? { phases: phaseOverrides } : { phases: null as unknown as Record<string, PhaseOverride> }),
        },
      },
      { onSuccess: () => setDirty(false) },
    );
  }

  function handleClear() {
    updateMutation.mutate(
      {
        taskId,
        config: {
          provider: null as unknown as ProviderConfig,
          model: null as unknown as string,
          maxTurns: null as unknown as number,
          timeoutSeconds: null as unknown as number,
          phases: null as unknown as Record<string, PhaseOverride>,
        },
      },
      {
        onSuccess: () => {
          setProviderType('cloud');
          setModel('');
          setBaseUrl('');
          setContextLength('');
          setMaxTurns('');
          setTimeoutSeconds('');
          setPhaseOverrides({});
          setDirty(false);
        },
      },
    );
  }

  function handleTest() {
    const isLocal = providerType === 'ollama' || providerType === 'lmstudio';
    const config: ProviderConfig = {
      type: providerType as ProviderConfig['type'],
      ...(isLocal && baseUrl ? { base_url: baseUrl } : {}),
    };
    testMutation.mutate(config);
  }

  return (
    <Surface level="low" className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
          Task Config
        </h2>
        {currentConfig && (
          <Button variant="ghost" size="sm" onClick={handleClear} className="text-xs text-on-surface-variant">
            Clear All Overrides
          </Button>
        )}
      </div>

      {/* Task-level provider/model */}
      <ProviderModelSelector
        providerType={providerType}
        model={model}
        baseUrl={baseUrl}
        contextLength={contextLength}
        modelPlaceholder={defaults?.model}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        onProviderChange={handleProviderChange}
        onModelChange={(m) => { setModel(m); setDirty(true); }}
        onBaseUrlChange={(url) => { setBaseUrl(url); setDirty(true); }}
        onContextLengthChange={(ctx) => { setContextLength(ctx); setDirty(true); }}
      />

      {/* Task-level maxTurns + timeout */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Max Turns</label>
          <Input
            type="number"
            value={maxTurns}
            onChange={(e) => { setMaxTurns(e.target.value); setDirty(true); }}
            placeholder={defaults?.maxTurns != null ? String(defaults.maxTurns) : '—'}
          />
        </div>
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Timeout (seconds)</label>
          <Input
            type="number"
            value={timeoutSeconds}
            onChange={(e) => { setTimeoutSeconds(e.target.value); setDirty(true); }}
            placeholder={defaults?.timeoutSeconds != null ? String(defaults.timeoutSeconds) : '—'}
          />
        </div>
      </div>

      {/* Actions row */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleTest}
          disabled={testMutation.isPending}
          className="gap-1.5 text-on-surface-variant"
        >
          {testMutation.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
          Test
        </Button>

        {testMutation.isSuccess && (
          <span className="flex items-center gap-1 text-xs">
            {testMutation.data.ok ? (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                <span className="text-green-500 font-mono">{testMutation.data.latency_ms}ms</span>
              </>
            ) : (
              <>
                <XCircle className="h-3.5 w-3.5 text-red-400" />
                <span className="text-red-400">{testMutation.data.error}</span>
              </>
            )}
          </span>
        )}

        <div className="flex-1" />

        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || updateMutation.isPending}
          className="gap-1.5"
        >
          {updateMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
      </div>

      {/* Per-phase overrides */}
      {phases && phases.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-[var(--ghost-border)]">
          <h3 className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
            Per-Phase Overrides
          </h3>
          {phases.map((phase) => (
            <PhaseConfigRow
              key={phase.name}
              phase={phase}
              override={phaseOverrides[phase.name] ?? {}}
              taskModel={model || 'claude-sonnet-4-6'}
              providers={providers}
              isLoadingProviders={isLoadingProviders}
              onChange={(update) => handlePhaseChange(phase.name, update)}
            />
          ))}
        </div>
      )}
    </Surface>
  );
}
