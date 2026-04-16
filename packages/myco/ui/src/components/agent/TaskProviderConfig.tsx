import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, Zap, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ProviderModelSelector } from '../providers/ProviderModelSelector';
import {
  useProviders,
  useTaskConfig,
  useTestProvider,
  useUpdateTaskConfig,
  seedDraftFromProviderType,
  inferRuntimeFromProviderType,
  resolveReasoningModel,
  type ProviderConfig,
  type ProviderInfo,
  type PhaseOverride,
  type ScheduleOverride,
} from '../../hooks/use-providers';
import type { PhaseDefinition } from '../../hooks/use-agent';
import { useModels } from '../../hooks/use-models';

/* ---------- Types ---------- */

/** YAML-defined schedule defaults for a task (present only if the task defines a schedule). */
interface ScheduleDefaults {
  enabled: boolean;
  intervalSeconds: number;
  runIn: ('active' | 'idle' | 'sleep')[];
}

interface TaskProviderConfigProps {
  taskId: string;
  phases?: PhaseDefinition[];
  defaults?: {
    runtime?: string;
    providerType?: string;
    reasoningLevel?: 'low' | 'default' | 'high';
    reasoningMap?: Partial<Record<'low' | 'default' | 'high', string>>;
    model?: string;
    baseUrl?: string;
    contextLength?: number;
    maxTurns?: number;
    timeoutSeconds?: number;
  };
  schedule?: ScheduleDefaults;
  params?: Record<string, string | number | boolean>;
}

/* ---------- Sub-components ---------- */

/** Per-phase config row — collapsible. */
function PhaseConfigRow({
  phase,
  override,
  taskRuntime,
  taskProviderType,
  taskModel,
  taskReasoningMap,
  providers,
  isLoadingProviders,
  onChange,
}: {
  phase: PhaseDefinition;
  override: PhaseOverride;
  taskRuntime: string;
  taskProviderType: string;
  taskModel: string;
  taskReasoningMap?: Partial<Record<'low' | 'default' | 'high', string>>;
  providers: ProviderInfo[];
  isLoadingProviders: boolean;
  onChange: (update: PhaseOverride | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasOverride = override.provider !== undefined || override.model !== undefined || override.maxTurns !== undefined;
  const modelPlaceholder = phase.model
    ?? resolveReasoningModel(
      phase.reasoningLevel,
      {
        model: taskModel || undefined,
        reasoning_map: taskReasoningMap,
      },
      taskModel,
    );

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
              runtime={override.provider?.runtime ?? taskRuntime}
              providerType={override.provider?.type ?? taskProviderType}
              model={override.provider?.model ?? override.model ?? ''}
              baseUrl={override.provider?.base_url ?? ''}
              contextLength={override.provider?.context_length != null ? String(override.provider.context_length) : ''}
              modelPlaceholder={modelPlaceholder}
              providers={providers}
              isLoadingProviders={isLoadingProviders}
              showRuntimeSelector={false}
              onRuntimeChange={() => {}}
              onProviderChange={(type) => {
                const bp = providers.find(p => p.type === type)?.baseUrl;
                onChange({
                  ...override,
                  provider: {
                    runtime: (override.provider?.runtime ?? taskRuntime) as ProviderConfig['runtime'],
                    type: type as ProviderConfig['type'],
                    base_url: bp,
                  },
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

/* ---------- Constants ---------- */

const POWER_STATES = ['active', 'idle', 'sleep'] as const;
type PowerState = (typeof POWER_STATES)[number];

const POWER_STATE_LABELS: Record<PowerState, string> = {
  active: 'Active',
  idle: 'Idle',
  sleep: 'Sleep',
};

/* ---------- Component ---------- */

export function TaskProviderConfig({ taskId, phases, defaults, schedule, params }: TaskProviderConfigProps) {
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const { data: taskConfigData } = useTaskConfig(taskId);
  const testMutation = useTestProvider();
  const updateMutation = useUpdateTaskConfig();

  const currentConfig = taskConfigData?.config;

  const [runtime, setRuntime] = useState<string>('claude-sdk');
  const [providerType, setProviderType] = useState<string>('anthropic');
  const [model, setModel] = useState<string>('');
  const [reasoningLow, setReasoningLow] = useState<string>('');
  const [reasoningDefault, setReasoningDefault] = useState<string>('');
  const [reasoningHigh, setReasoningHigh] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState<string>('');
  const [contextLength, setContextLength] = useState<string>('');
  const [maxTurns, setMaxTurns] = useState<string>('');
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>('');
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>({});
  const [scheduleOverride, setScheduleOverride] = useState<ScheduleOverride>({});
  const [paramsOverride, setParamsOverride] = useState<Record<string, string | number | boolean>>({});
  const [dirty, setDirty] = useState(false);
  const providers = providersData?.providers ?? [];
  const reasoningModelsQuery = useModels(providerType || null, baseUrl || undefined, 'llm');
  const reasoningModels = reasoningModelsQuery.data?.models ?? providers.find((provider) => provider.type === providerType)?.models ?? [];
  const effectiveRuntime = runtime
    || inferRuntimeFromProviderType(providerType as Parameters<typeof inferRuntimeFromProviderType>[0])
    || defaults?.runtime
    || inferRuntimeFromProviderType(defaults?.providerType as Parameters<typeof inferRuntimeFromProviderType>[0])
    || 'claude-sdk';

  useEffect(() => {
    if (!runtime && effectiveRuntime) {
      setRuntime(effectiveRuntime);
    }
  }, [effectiveRuntime, runtime]);

  // Sync from myco.yaml config when it loads
  useEffect(() => {
    if (!taskConfigData) return;
    setRuntime(
      currentConfig?.runtime
      ?? currentConfig?.provider?.runtime
      ?? inferRuntimeFromProviderType(currentConfig?.provider?.type)
      ?? defaults?.runtime
      ?? inferRuntimeFromProviderType(defaults?.providerType as Parameters<typeof inferRuntimeFromProviderType>[0])
      ?? 'claude-sdk',
    );
    setProviderType(currentConfig?.provider?.type ?? defaults?.providerType ?? 'anthropic');
    setModel(currentConfig?.provider?.model ?? currentConfig?.model ?? defaults?.model ?? '');
    setReasoningLow(currentConfig?.provider?.reasoning_map?.low ?? defaults?.reasoningMap?.low ?? '');
    setReasoningDefault(
      currentConfig?.provider?.reasoning_map?.default
      ?? currentConfig?.provider?.model
      ?? currentConfig?.model
      ?? defaults?.reasoningMap?.default
      ?? defaults?.model
      ?? '',
    );
    setReasoningHigh(currentConfig?.provider?.reasoning_map?.high ?? defaults?.reasoningMap?.high ?? '');
    setBaseUrl(currentConfig?.provider?.base_url ?? defaults?.baseUrl ?? '');
    setContextLength(
      currentConfig?.provider?.context_length != null
        ? String(currentConfig.provider.context_length)
        : defaults?.contextLength != null
          ? String(defaults.contextLength)
          : '',
    );
    setMaxTurns(currentConfig?.maxTurns != null ? String(currentConfig.maxTurns) : '');
    setTimeoutSeconds(currentConfig?.timeoutSeconds != null ? String(currentConfig.timeoutSeconds) : '');
    setPhaseOverrides(currentConfig?.phases ?? {});
    setScheduleOverride(currentConfig?.schedule ?? {});
    setParamsOverride(currentConfig?.params ?? {});
    setDirty(false);
  }, [
    currentConfig,
    taskConfigData,
    defaults?.runtime,
    defaults?.providerType,
    defaults?.model,
    defaults?.reasoningMap,
    defaults?.baseUrl,
    defaults?.contextLength,
    defaults?.maxTurns,
    defaults?.timeoutSeconds,
  ]);

  // Effective schedule values: user override merged over YAML defaults
  const effectiveScheduleEnabled = scheduleOverride.enabled ?? schedule?.enabled ?? false;
  const effectiveRunIn = scheduleOverride.runIn ?? schedule?.runIn ?? [];
  function handleProviderChange(type: string) {
    // Default to the first available model so the dropdown never shows a
    // stale value from the previous provider (Radix Select renders the prior
    // value instead of the placeholder when value='' is passed).
      const draft = seedDraftFromProviderType(type, providers);
      setRuntime(draft.runtime || runtime);
      setProviderType(type);
      setModel(draft.model || defaults?.model || '');
      setReasoningLow(draft.reasoningLow);
      setReasoningDefault(draft.reasoningDefault || draft.model || defaults?.model || '');
      setReasoningHigh(draft.reasoningHigh);
    setBaseUrl(draft.baseUrl);
    setContextLength(draft.contextLength);
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
    const isLocal = providerType === 'ollama' || providerType === 'lmstudio' || providerType === 'openai-compatible';
    const reasoningMap = {
      ...(reasoningLow ? { low: reasoningLow } : {}),
      ...(reasoningDefault ? { default: reasoningDefault } : {}),
      ...(reasoningHigh ? { high: reasoningHigh } : {}),
    };
    const provider: ProviderConfig = {
      runtime: effectiveRuntime as ProviderConfig['runtime'],
      type: providerType as ProviderConfig['type'],
      ...(model ? { model } : {}),
      ...(Object.keys(reasoningMap).length > 0 ? { reasoning_map: reasoningMap } : {}),
      ...(isLocal && baseUrl ? { base_url: baseUrl } : {}),
      ...(isLocal && contextLength ? { context_length: Number(contextLength) } : {}),
    };

    // Build schedule payload: only include fields the user has overridden
    const schedulePayload = schedule
      ? (Object.keys(scheduleOverride).length > 0 ? { schedule: scheduleOverride } : { schedule: null as unknown as ScheduleOverride })
      : {};

    // Build params payload: only include if task declares params
    const paramsPayload = params && Object.keys(paramsOverride).length > 0
      ? { params: paramsOverride }
      : {};

    updateMutation.mutate(
      {
        taskId,
        config: {
          runtime: effectiveRuntime as 'claude-sdk' | 'openai-agents',
          provider,
          ...(maxTurns ? { maxTurns: Number(maxTurns) } : { maxTurns: null as unknown as number }),
          ...(timeoutSeconds ? { timeoutSeconds: Number(timeoutSeconds) } : { timeoutSeconds: null as unknown as number }),
          ...(Object.keys(phaseOverrides).length > 0 ? { phases: phaseOverrides } : { phases: null as unknown as Record<string, PhaseOverride> }),
          ...schedulePayload,
          ...paramsPayload,
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
          runtime: null as unknown as 'claude-sdk' | 'openai-agents',
          provider: null as unknown as ProviderConfig,
          model: null as unknown as string,
          maxTurns: null as unknown as number,
          timeoutSeconds: null as unknown as number,
          phases: null as unknown as Record<string, PhaseOverride>,
          schedule: null as unknown as ScheduleOverride,
          params: null as unknown as Record<string, string | number | boolean>,
        },
      },
      {
        onSuccess: () => {
          setRuntime(
            defaults?.runtime
            ?? inferRuntimeFromProviderType(defaults?.providerType as Parameters<typeof inferRuntimeFromProviderType>[0])
            ?? 'claude-sdk',
          );
          setProviderType(defaults?.providerType ?? 'anthropic');
          setModel(defaults?.model ?? '');
          setReasoningLow(defaults?.reasoningMap?.low ?? '');
          setReasoningDefault(defaults?.reasoningMap?.default ?? defaults?.model ?? '');
          setReasoningHigh(defaults?.reasoningMap?.high ?? '');
          setBaseUrl(defaults?.baseUrl ?? '');
          setContextLength(defaults?.contextLength != null ? String(defaults.contextLength) : '');
          setMaxTurns('');
          setTimeoutSeconds('');
          setPhaseOverrides({});
          setScheduleOverride({});
          setParamsOverride({});
          setDirty(false);
        },
      },
    );
  }

  function handleTest() {
    const isLocal = providerType === 'ollama' || providerType === 'lmstudio' || providerType === 'openai-compatible';
    const config: ProviderConfig = {
      runtime: effectiveRuntime as ProviderConfig['runtime'],
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
        runtime={effectiveRuntime}
        providerType={providerType}
        model={model}
        baseUrl={baseUrl}
        contextLength={contextLength}
        modelPlaceholder={defaults?.model}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        onRuntimeChange={(nextRuntime) => {
          setRuntime(nextRuntime);
          const firstProvider = providers.find((provider) => provider.runtime === nextRuntime);
          if (firstProvider) {
            const draft = seedDraftFromProviderType(firstProvider.type, providers);
            setProviderType(draft.type);
            setModel(draft.model);
            setReasoningLow(draft.reasoningLow);
            setReasoningDefault(draft.reasoningDefault || draft.model);
            setReasoningHigh(draft.reasoningHigh);
            setBaseUrl(draft.baseUrl);
            setContextLength(draft.contextLength);
          }
          setDirty(true);
        }}
        onProviderChange={handleProviderChange}
        onModelChange={(m) => { setModel(m); setDirty(true); }}
        onBaseUrlChange={(url) => { setBaseUrl(url); setDirty(true); }}
        onContextLengthChange={(ctx) => { setContextLength(ctx); setDirty(true); }}
      />

      {providerType !== '' && (
        <div className="space-y-3 rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest p-3">
          <div>
            <p className="font-sans text-xs text-on-surface-variant uppercase tracking-wide">Reasoning Profiles</p>
            <p className="font-sans text-xs text-on-surface-variant/80 mt-1">
              Built-in task reasoning levels resolve through these task-level model mappings before falling back to the inherited defaults.
            </p>
          </div>
          {([
            ['low', 'Reasoning Low', reasoningLow, setReasoningLow],
            ['default', 'Reasoning Default', reasoningDefault, setReasoningDefault],
            ['high', 'Reasoning High', reasoningHigh, setReasoningHigh],
          ] as const).map(([level, label, value, setValue]) => {
            const placeholder = resolveReasoningModel(
              level,
              {
                model: model || undefined,
                reasoning_map: {
                  ...(reasoningLow ? { low: reasoningLow } : {}),
                  ...(reasoningDefault ? { default: reasoningDefault } : {}),
                  ...(reasoningHigh ? { high: reasoningHigh } : {}),
                },
              },
              defaults?.reasoningMap?.[level] ?? defaults?.model,
            );

            return (
              <div key={level} className="space-y-1">
                <label className="font-sans text-xs text-on-surface-variant">{label}</label>
                {reasoningModels.length > 0 ? (
                  <Select value={value} onValueChange={(next) => { setValue(next); setDirty(true); }}>
                    <SelectTrigger>
                      <SelectValue placeholder={placeholder || 'Use inherited model'} />
                    </SelectTrigger>
                    <SelectContent>
                      {reasoningModels.map((candidate) => (
                        <SelectItem key={`${level}-${candidate}`} value={candidate}>
                          <span className="font-mono text-sm">{candidate}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setDirty(true); }}
                    placeholder={placeholder || 'Use inherited model'}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

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

      {/* Scheduling (only for tasks that define a schedule in YAML) */}
      {schedule && (
        <div className="space-y-3 pt-2 border-t border-[var(--ghost-border)]">
          <div className="flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-on-surface-variant" />
            <h3 className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
              Scheduling
            </h3>
            <Badge
              variant={effectiveScheduleEnabled ? 'secondary' : 'outline'}
              className="text-[10px] px-1.5 py-0"
            >
              {effectiveScheduleEnabled ? 'active' : 'off'}
            </Badge>
          </div>

          {/* Auto-run toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <label className="font-sans text-xs text-on-surface">Auto-run</label>
              <p className="font-sans text-[11px] text-on-surface-variant">
                Automatically run this task on a schedule
              </p>
            </div>
            <Switch
              checked={effectiveScheduleEnabled}
              onCheckedChange={(checked) => {
                setScheduleOverride((prev) => ({ ...prev, enabled: checked }));
                setDirty(true);
              }}
            />
          </div>

          {/* Interval + run-in states (visible only when enabled) */}
          {effectiveScheduleEnabled && (
            <div className="space-y-3 pl-0.5">
              {/* Interval */}
              <div className="space-y-1">
                <label className="font-sans text-xs text-on-surface-variant">
                  Run every (seconds)
                </label>
                <Input
                  type="number"
                  min={10}
                  value={scheduleOverride.intervalSeconds ?? ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    setScheduleOverride((prev) => ({
                      ...prev,
                      intervalSeconds: val ? Number(val) : undefined,
                    }));
                    setDirty(true);
                  }}
                  placeholder={schedule.intervalSeconds != null ? String(schedule.intervalSeconds) : '300'}
                />
              </div>

              {/* Run in states */}
              <div className="space-y-1.5">
                <label className="font-sans text-xs text-on-surface-variant">
                  Run in states
                </label>
                <div className="flex gap-2">
                  {POWER_STATES.map((state) => {
                    const isActive = effectiveRunIn.includes(state);
                    return (
                      <button
                        key={state}
                        onClick={() => {
                          const next = isActive
                            ? effectiveRunIn.filter((s) => s !== state)
                            : [...effectiveRunIn, state];
                          // Only set override if different from YAML default
                          setScheduleOverride((prev) => ({ ...prev, runIn: next.length > 0 ? next : undefined }));
                          setDirty(true);
                        }}
                        className={`
                          rounded-md border px-3 py-1.5 font-sans text-xs font-medium transition-colors
                          ${isActive
                            ? 'border-primary/40 bg-primary/5 text-on-surface'
                            : 'border-[var(--ghost-border)] bg-surface-container-lowest text-on-surface-variant hover:border-primary/20'
                          }
                        `}
                      >
                        {POWER_STATE_LABELS[state]}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Task-specific params */}
      {params && Object.keys(params).length > 0 && (
        <div className="space-y-3 pt-2 border-t border-[var(--ghost-border)]">
          <h3 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">Parameters</h3>
          {Object.entries(params).map(([key, defaultValue]) => {
            const overrideValue = paramsOverride[key];
            const effectiveValue = overrideValue ?? defaultValue;
            const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

            if (typeof defaultValue === 'boolean') {
              return (
                <div key={key} className="flex items-center justify-between">
                  <label className="font-sans text-sm text-on-surface">{label}</label>
                  <Switch
                    checked={effectiveValue as boolean}
                    onCheckedChange={(v) => {
                      setParamsOverride(prev => ({ ...prev, [key]: v }));
                      setDirty(true);
                    }}
                  />
                </div>
              );
            }

            return (
              <div key={key} className="space-y-1">
                <label className="font-sans text-sm text-on-surface">{label}</label>
                <div className="flex items-center gap-2">
                  <Input
                    type={typeof defaultValue === 'number' ? 'number' : 'text'}
                    value={overrideValue != null ? String(overrideValue) : ''}
                    placeholder={String(defaultValue)}
                    onChange={(e) => {
                      const val = typeof defaultValue === 'number'
                        ? (e.target.value === '' ? undefined : Number(e.target.value))
                        : e.target.value;
                      if (val === undefined) {
                        setParamsOverride(prev => {
                          const next = { ...prev };
                          delete next[key];
                          return next;
                        });
                      } else {
                        setParamsOverride(prev => ({ ...prev, [key]: val }));
                      }
                      setDirty(true);
                    }}
                    className="w-40 font-mono"
                  />
                  <span className="font-sans text-xs text-on-surface-variant">
                    default: {String(defaultValue)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

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
              taskRuntime={effectiveRuntime}
              taskProviderType={providerType}
              taskModel={model || defaults?.model || ''}
              taskReasoningMap={{
                ...(defaults?.reasoningMap ?? {}),
                ...(reasoningLow ? { low: reasoningLow } : {}),
                ...(reasoningDefault ? { default: reasoningDefault } : {}),
                ...(reasoningHigh ? { high: reasoningHigh } : {}),
              }}
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
