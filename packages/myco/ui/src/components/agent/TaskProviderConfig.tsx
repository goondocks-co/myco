import { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, Loader2, Zap, Clock } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { ProviderModelSelector } from '../providers/ProviderModelSelector';
import { AdvancedModelPin } from '../providers/AdvancedModelPin';
import { ReasoningProfiles } from '../providers/ReasoningProfiles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { PhaseConfigRow } from './PhaseConfigRow';
import {
  defaultBaseUrlForProvider,
  useProviders,
  useTaskConfig,
  useTestProvider,
  useUpdateTaskConfig,
  maybeInferHarnessFromProviderType,
  REASONING_LEVELS,
  type ProviderConfig,
  type PhaseOverride,
  type ScheduleOverride,
  type ReasoningLevelUi,
} from '../../hooks/use-providers';
import { useModels } from '../../hooks/use-models';
import type { PhaseDefinition } from '../../hooks/use-agent';
import {
  draftToNormalizedProviderConfig,
  providerDraftFromSource,
  useProviderConfigDraft,
} from '../../hooks/use-provider-config-draft';

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
    harness?: string;
    providerType?: string;
    localBackend?: 'ollama' | 'lmstudio';
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

/* ---------- Constants ---------- */

const POWER_STATES = ['active', 'idle', 'sleep'] as const;
type PowerState = (typeof POWER_STATES)[number];

const POWER_STATE_LABELS: Record<PowerState, string> = {
  active: 'Active',
  idle: 'Idle',
  sleep: 'Sleep',
};

const TASK_DEFAULT_SENTINEL = '__task_default__';

function serializeComparable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function taskConfigSnapshot(config: {
  maxTurns?: number;
  timeoutSeconds?: number;
  phases?: Record<string, PhaseOverride>;
  schedule?: ScheduleOverride;
  params?: Record<string, string | number | boolean>;
} | null | undefined) {
  return {
    maxTurns: config?.maxTurns != null ? String(config.maxTurns) : '',
    timeoutSeconds: config?.timeoutSeconds != null ? String(config.timeoutSeconds) : '',
    phaseOverrides: config?.phases ?? {},
    scheduleOverride: config?.schedule ?? {},
    paramsOverride: config?.params ?? {},
  };
}

/* ---------- Component ---------- */

export function TaskProviderConfig({ taskId, phases, defaults, schedule, params }: TaskProviderConfigProps) {
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const { data: taskConfigData } = useTaskConfig(taskId);
  const testMutation = useTestProvider();
  const updateMutation = useUpdateTaskConfig();

  const currentConfig = taskConfigData?.config;
  const initialTaskSnapshot = taskConfigSnapshot(currentConfig);
  const [maxTurns, setMaxTurns] = useState<string>(initialTaskSnapshot.maxTurns);
  const [timeoutSeconds, setTimeoutSeconds] = useState<string>(initialTaskSnapshot.timeoutSeconds);
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>(initialTaskSnapshot.phaseOverrides);
  const [scheduleOverride, setScheduleOverride] = useState<ScheduleOverride>(initialTaskSnapshot.scheduleOverride);
  const [paramsOverride, setParamsOverride] = useState<Record<string, string | number | boolean>>(initialTaskSnapshot.paramsOverride);
  const [savedTaskSnapshot, setSavedTaskSnapshot] = useState(initialTaskSnapshot);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevelUi | undefined>(currentConfig?.reasoningLevel);
  const [savedReasoningLevel, setSavedReasoningLevel] = useState<ReasoningLevelUi | undefined>(currentConfig?.reasoningLevel);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const providers = providersData?.providers ?? [];
  const providerDraftDefaults = {
    harness: defaults?.harness,
    providerType: defaults?.providerType,
    localBackend: defaults?.localBackend,
    model: defaults?.model,
    reasoningMap: defaults?.reasoningMap,
    baseUrl: defaults?.baseUrl,
    contextLength: defaults?.contextLength,
  };
  const {
    draft,
    isDirty: isProviderDirty,
    commitDraft,
    handleHarnessChange: handleDraftHarnessChange,
    handleProviderChange: handleDraftProviderChange,
    handleModelChange: handleDraftModelChange,
    handleLocalBackendChange: handleDraftLocalBackendChange,
    handleReasoningChange: handleDraftReasoningChange,
    handleBaseUrlChange: handleDraftBaseUrlChange,
    handleContextLengthChange: handleDraftContextLengthChange,
  } = useProviderConfigDraft({
    source: {
      harness: currentConfig?.harness,
      provider: currentConfig?.provider,
      model: currentConfig?.model,
    },
    defaults: providerDraftDefaults,
    providers,
  });
  const harness = draft.harness;
  const providerType = draft.type;
  const model = draft.model;
  const reasoningLow = draft.reasoningLow;
  const reasoningDefault = draft.reasoningDefault;
  const reasoningHigh = draft.reasoningHigh;
  const baseUrl = draft.baseUrl;
  const contextLength = draft.contextLength;
  const resolvedTaskBaseUrl = baseUrl || defaultBaseUrlForProvider(providerType, draft.localBackend);
  const reasoningModelsQuery = useModels(providerType || null, resolvedTaskBaseUrl || undefined, 'llm', draft.localBackend || null);
  const reasoningModels = reasoningModelsQuery.data?.models ?? providers.find((provider) => provider.type === providerType)?.models ?? [];
  const effectiveHarness = harness
    || maybeInferHarnessFromProviderType(providerType)
    || defaults?.harness
    || maybeInferHarnessFromProviderType(defaults?.providerType)
    || 'claude-sdk';
  const isDirty = isProviderDirty
    || reasoningLevel !== savedReasoningLevel
    || maxTurns !== savedTaskSnapshot.maxTurns
    || timeoutSeconds !== savedTaskSnapshot.timeoutSeconds
    || serializeComparable(phaseOverrides) !== serializeComparable(savedTaskSnapshot.phaseOverrides)
    || serializeComparable(scheduleOverride) !== serializeComparable(savedTaskSnapshot.scheduleOverride)
    || serializeComparable(paramsOverride) !== serializeComparable(savedTaskSnapshot.paramsOverride);

  // Sync from myco.yaml config when it loads
  useEffect(() => {
    if (!taskConfigData) return;
    const snapshot = taskConfigSnapshot(currentConfig);
    setMaxTurns(snapshot.maxTurns);
    setTimeoutSeconds(snapshot.timeoutSeconds);
    setPhaseOverrides(snapshot.phaseOverrides);
    setScheduleOverride(snapshot.scheduleOverride);
    setParamsOverride(snapshot.paramsOverride);
    setSavedTaskSnapshot(snapshot);
    setReasoningLevel(currentConfig?.reasoningLevel);
    setSavedReasoningLevel(currentConfig?.reasoningLevel);
    if (currentConfig?.model) setAdvancedOpen(true);
  }, [
    currentConfig,
    taskConfigData,
    defaults?.maxTurns,
    defaults?.timeoutSeconds,
  ]);

  // Server effective state is authoritative; only layer an unsaved local
  // toggle draft over it while the user is editing.
  const draftScheduleEnabled = scheduleOverride.enabled ?? schedule?.enabled ?? false;
  const savedScheduleEnabled = savedTaskSnapshot.scheduleOverride.enabled;
  const hasScheduleEnabledDraft = scheduleOverride.enabled !== savedScheduleEnabled;
  const scheduleCapabilityDisabled = taskConfigData?.capability != null
    && taskConfigData.capabilityEnabled === false;
  const effectiveScheduleEnabled = scheduleCapabilityDisabled
    ? false
    : (
      hasScheduleEnabledDraft
        ? draftScheduleEnabled
        : (taskConfigData?.effectiveScheduleEnabled ?? draftScheduleEnabled)
    );
  const effectiveRunIn = scheduleOverride.runIn ?? schedule?.runIn ?? [];
  function handleProviderChange(type: string) {
    handleDraftProviderChange(type);
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
  }

  function handleSave() {
    const provider = draftToNormalizedProviderConfig(
      { ...draft, harness: effectiveHarness as 'claude-sdk' | 'openai-agents' },
      reasoningModels,
    );
    if (!provider) {
      return;
    }

    // Build schedule payload: only include fields the user has overridden
    const schedulePayload = schedule
      ? (Object.keys(scheduleOverride).length > 0 ? { schedule: scheduleOverride } : { schedule: null })
      : {};

    // Build params payload: only include if task declares params
    const paramsPayload = params && Object.keys(paramsOverride).length > 0
      ? { params: paramsOverride }
      : {};

    updateMutation.mutate(
      {
        taskId,
        config: {
          harness: effectiveHarness as 'claude-sdk' | 'openai-agents',
          provider,
          reasoningLevel: reasoningLevel ?? null,
          maxTurns: maxTurns ? Number(maxTurns) : null,
          timeoutSeconds: timeoutSeconds ? Number(timeoutSeconds) : null,
          phases: Object.keys(phaseOverrides).length > 0 ? phaseOverrides : null,
          ...schedulePayload,
          ...paramsPayload,
        },
      },
      {
        onSuccess: () => {
          commitDraft(providerDraftFromSource(
            { harness: effectiveHarness, provider },
            providerDraftDefaults,
          ));
          setSavedReasoningLevel(reasoningLevel);
          setSavedTaskSnapshot({
            maxTurns,
            timeoutSeconds,
            phaseOverrides,
            scheduleOverride,
            paramsOverride,
          });
        },
      },
    );
  }

  function handleClear() {
    updateMutation.mutate(
      {
        taskId,
        config: {
          harness: null,
          provider: null,
          reasoningLevel: null,
          model: null,
          maxTurns: null,
          timeoutSeconds: null,
          phases: null,
          schedule: null,
          params: null,
        },
      },
      {
        onSuccess: () => {
          const clearedSnapshot = taskConfigSnapshot(null);
          commitDraft(providerDraftFromSource(null, providerDraftDefaults));
          setReasoningLevel(undefined);
          setSavedReasoningLevel(undefined);
          setAdvancedOpen(false);
          setMaxTurns(clearedSnapshot.maxTurns);
          setTimeoutSeconds(clearedSnapshot.timeoutSeconds);
          setPhaseOverrides(clearedSnapshot.phaseOverrides);
          setScheduleOverride(clearedSnapshot.scheduleOverride);
          setParamsOverride(clearedSnapshot.paramsOverride);
          setSavedTaskSnapshot(clearedSnapshot);
        },
      },
    );
  }

  function handleTest() {
    const isLocal = providerType === 'ollama' || providerType === 'lmstudio' || providerType === 'openai-compatible';
    const config: ProviderConfig = {
      type: providerType as ProviderConfig['type'],
      ...(providerType === 'openai-compatible' && draft.localBackend ? { local_backend: draft.localBackend } : {}),
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
        harness={effectiveHarness}
        providerType={providerType}
        localBackend={draft.localBackend}
        model={model}
        baseUrl={baseUrl}
        contextLength={contextLength}
        modelPlaceholder={defaults?.model}
        providers={providers}
        isLoadingProviders={isLoadingProviders}
        showModelSelector={false}
        onHarnessChange={(nextHarness) => {
          handleDraftHarnessChange(nextHarness);
        }}
        onProviderChange={handleProviderChange}
        onLocalBackendChange={handleDraftLocalBackendChange}
        onModelChange={handleDraftModelChange}
        onBaseUrlChange={handleDraftBaseUrlChange}
        onContextLengthChange={handleDraftContextLengthChange}
      />

      {/* Task default reasoning profile — the model resolves through the
          reasoning map below (or the inherited map) at run time. */}
      <div className="space-y-1">
        <label className="font-sans text-xs text-on-surface-variant">Default reasoning profile</label>
        <Select
          value={reasoningLevel ?? TASK_DEFAULT_SENTINEL}
          onValueChange={(val) =>
            setReasoningLevel(val === TASK_DEFAULT_SENTINEL ? undefined : (val as ReasoningLevelUi))
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TASK_DEFAULT_SENTINEL}>
              Use inherited default ({defaults?.reasoningLevel ?? 'default'})
            </SelectItem>
            {REASONING_LEVELS.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="font-sans text-[11px] text-on-surface-variant/70">
          Resolves to a model through the reasoning profiles below.
        </p>
      </div>

      {providerType !== '' && (
        <ReasoningProfiles
          description="Built-in task reasoning levels resolve through these task-level model mappings before falling back to the inherited defaults."
          values={{
            low: reasoningLow,
            default: reasoningDefault,
            high: reasoningHigh,
          }}
          onChange={handleDraftReasoningChange}
          models={reasoningModels}
          fallbackModel={model || defaults?.model}
          fallbackReasoningMap={defaults?.reasoningMap}
          placeholderWhenEmpty="Use inherited model"
        />
      )}

      {/* Advanced — pin a specific model SKU (escape hatch / local providers
          without a reasoning map). Controlled here so a saved model override
          auto-opens it on load and "Clear All Overrides" collapses it. */}
      {providerType !== '' && (
        <AdvancedModelPin
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          providerType={providerType}
          localBackend={draft.localBackend}
          baseUrl={baseUrl}
          model={model}
          modelPlaceholder={defaults?.model}
          providers={providers}
          onModelChange={handleDraftModelChange}
        />
      )}

      {/* Task-level maxTurns + timeout */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Max Turns</label>
          <Input
            type="number"
            value={maxTurns}
            onChange={(e) => { setMaxTurns(e.target.value); }}
            placeholder={defaults?.maxTurns != null ? String(defaults.maxTurns) : '—'}
          />
        </div>
        <div className="space-y-1">
          <label className="font-sans text-xs text-on-surface-variant">Timeout (seconds)</label>
          <Input
            type="number"
            value={timeoutSeconds}
            onChange={(e) => { setTimeoutSeconds(e.target.value); }}
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
          disabled={!isDirty || updateMutation.isPending}
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
              {scheduleCapabilityDisabled
                ? 'governed off'
                : (effectiveScheduleEnabled ? 'active' : 'off')}
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
              disabled={scheduleCapabilityDisabled}
              onCheckedChange={(checked) => {
                setScheduleOverride((prev) => ({ ...prev, enabled: checked }));
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
              taskHarness={effectiveHarness}
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
