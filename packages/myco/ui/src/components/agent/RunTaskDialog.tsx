import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Loader2, Play, RotateCcw } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ProviderModelSelector } from '../providers/ProviderModelSelector';
import { PhaseConfigRow } from './PhaseConfigRow';
import {
  useAgentTasks,
  useTriggerRun,
  type RunRow,
  type TaskRow,
} from '../../hooks/use-agent';
import { buildRerunPrefill } from './rerun-prefill';
import {
  draftToNormalizedProviderConfig,
  useProviderConfigDraft,
} from '../../hooks/use-provider-config-draft';
import {
  parseProviderType,
  parseHarnessId,
  resolveReasoningModel,
  useProviders,
  REASONING_LEVELS,
  type PhaseOverride,
  type ProviderConfig,
} from '../../hooks/use-providers';
import { useTaskExecutionDefaults } from '../../hooks/use-task-execution-defaults';
import { useModels } from '../../hooks/use-models';
import type { HarnessId, ReasoningLevel } from '@myco/agent/types';
import {
  buildExecutionOverrides,
  countOverrides,
  type EffectiveDefaults,
  type OverridesFormState,
} from './execution-overrides';
import { extractTemplateVars } from './shared-inputs';

/* ---------- Template variable labels ---------- */

const VAR_LABELS: Record<string, string> = {
  session_id: 'Session ID',
};

const VAR_PLACEHOLDERS: Record<string, string> = {
  session_id: 'e.g. 36858a44-4ef7-4448-96e8-382e992e8ba4',
};

/** Sentinel value used in Select components — native <Select> can't bind to
 *  `undefined`, so "use task default" gets encoded as this literal and
 *  converted back to `undefined` in the onChange handler. */
const TASK_DEFAULT_SENTINEL = '__task_default__';
const SKILL_SURVEY_TASK = 'skill-survey';

function varLabel(name: string): string {
  return VAR_LABELS[name] ?? name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function taskLabel(task: TaskRow): string {
  return task.displayName ?? task.name;
}

/* ---------- Component ---------- */

export interface RunTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the task is fixed and the picker is hidden. */
  preselectedTask?: TaskRow;
  onTriggered?: (runId?: string) => void;
  /**
   * Seeds the dialog with the same task + instruction + dry-run flag +
   * execution overrides as an existing run, for the "Rerun with same
   * settings" affordance. Starts a NEW run — does NOT modify the source.
   */
  sourceRun?: RunRow;
}

/**
 * Single-run "run a task" dialog. Posts to /agent/run with optional
 * `executionOverrides` — the per-run override path.
 */
export function RunTaskDialog({
  open,
  onOpenChange,
  preselectedTask,
  onTriggered,
  sourceRun,
}: RunTaskDialogProps) {
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [varValues, setVarValues] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [runNotice, setRunNotice] = useState<string | null>(null);

  // Run-configuration form state. `undefined` in any slot means "use task
  // default"; the submit path only sends fields that actually differ (see
  // buildExecutionOverrides).
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningLevel | undefined>(undefined);
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>({});

  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();
  const { mutate: triggerRun, isPending, error } = useTriggerRun();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const providers = providersData?.providers ?? [];

  // Resolve the active task row
  const availableTasks: TaskRow[] = tasksData?.tasks ?? [];
  const defaultTask = availableTasks.find((t) => t.isDefault);
  const effectiveSelection = preselectedTask?.name
    ?? selectedTask
    ?? defaultTask?.name
    ?? availableTasks[0]?.name
    ?? '';

  const {
    taskRow: resolvedTaskRow,
    harness: taskDefaultHarness,
    provider: taskDefaultProvider,
    providerType: taskDefaultProviderType,
    modelFallback: taskDefaultModelFallback,
    reasoning: taskDefaultReasoning,
    resolvedModel: taskDefaultModel,
    draftSource: providerDraftSource,
    draftDefaults: providerDraftDefaults,
  } = useTaskExecutionDefaults(effectiveSelection || undefined);
  const activeTaskRow = preselectedTask ?? resolvedTaskRow;

  const {
    draft,
    isDirty: isProviderDirty,
    handleHarnessChange: handleDraftHarnessChange,
    handleProviderChange: handleDraftProviderChange,
    handleModelChange: handleDraftModelChange,
    handleLocalBackendChange: handleDraftLocalBackendChange,
    handleBaseUrlChange: handleDraftBaseUrlChange,
    handleContextLengthChange: handleDraftContextLengthChange,
    setDraft: setProviderDraft,
  } = useProviderConfigDraft({
    source: providerDraftSource,
    defaults: providerDraftDefaults,
    providers,
  });

  const resolvedDraftBaseUrl = draft.baseUrl
    || providers.find((p) => p.type === draft.type)?.baseUrl
    || '';
  const modelsQuery = useModels(draft.type || null, resolvedDraftBaseUrl || undefined, 'llm', draft.localBackend || null);
  const availableModels = modelsQuery.data?.models
    ?? providers.find((p) => p.type === draft.type)?.models
    ?? [];

  // Records the source run id we've already seeded form state for, so the
  // task-change reset effect can tell "selection changed because prefill just
  // ran" apart from "user picked a different task." Cleared on dialog close.
  const sourceRunSeededRef = useRef<string | null>(null);

  // Reset transient state when the dialog opens/closes or the task changes.
  useEffect(() => {
    if (!open) {
      setSelectedTask(undefined);
      setVarValues({});
      setInstruction('');
      setDryRun(false);
      setRunNotice(null);
      setOverridesOpen(false);
      setReasoning(undefined);
      setPhaseOverrides({});
      sourceRunSeededRef.current = null;
    }
  }, [open]);

  // Seed form state when opened from the "Rerun with same settings" action.
  // Fires whenever `sourceRun` flips identity while the dialog is open — e.g.
  // a user closes the dialog, triggers rerun on a different run, and reopens.
  // Also waits for `availableTasks` to hydrate before seeding, so the
  // prefill can correctly filter var values against the matching task's
  // template variables. If tasks aren't loaded when Rerun is first clicked,
  // the effect re-runs once they arrive.
  useEffect(() => {
    if (!open || !sourceRun) return;
    // Wait for tasks to hydrate — unless the fetch already finished (even if
    // empty), in which case we should proceed with whatever's known so the
    // deleted-task fallback path still works.
    if (availableTasks.length === 0 && tasksLoading) return;
    // Don't re-seed if we've already applied this source run once (user may
    // have edited since).
    if (sourceRunSeededRef.current === sourceRun.id) return;

    const prefill = buildRerunPrefill(sourceRun, availableTasks);
    setSelectedTask(prefill.taskName || undefined);
    setVarValues(prefill.varValues);
    setInstruction(prefill.instruction);
    setDryRun(prefill.dryRun);
    setReasoning(prefill.reasoningLevel);
    setPhaseOverrides(prefill.phaseOverrides);
    // Reseed the provider draft so ProviderModelSelector reflects the
    // rerun's provider override. Mirrors the "Reset to task defaults" pattern
    // but points at the source run's provider shape.
    if (prefill.provider) {
      setProviderDraft({
        harness: parseHarnessId(prefill.harness ?? providerDraftDefaults.harness ?? 'claude-sdk') || 'claude-sdk',
        type: parseProviderType(prefill.provider.type),
        localBackend: prefill.provider.local_backend ?? '',
        model: prefill.provider.model ?? '',
        reasoningLow: prefill.provider.reasoning_map?.low ?? '',
        reasoningDefault: prefill.provider.reasoning_map?.default ?? '',
        reasoningHigh: prefill.provider.reasoning_map?.high ?? '',
        baseUrl: prefill.provider.base_url ?? '',
        contextLength: prefill.provider.context_length != null
          ? String(prefill.provider.context_length)
          : '',
      });
    } else if (prefill.harness) {
      // Harness-only override (no full provider reseed): flip the draft's
      // harness so the displayed "harness" chip matches what will submit.
      setProviderDraft((prev) => ({ ...prev, harness: prefill.harness! }));
    }
    // Auto-expand the Override section when any override field is set.
    if (prefill.hasAnyOverride) setOverridesOpen(true);
    sourceRunSeededRef.current = sourceRun.id;
    // `availableTasks.length` is a coarse hydration signal — enough to re-run
    // once tasks arrive without thrashing on every refetch cycle (the length
    // is stable across identical result sets).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceRun, availableTasks.length, tasksLoading]);

  // Task-change reset: wipe reasoning/phase overrides when the operator
  // picks a different task from the dropdown. Intentionally skipped when the
  // selection change was caused by the rerun-prefill effect above (which
  // sets both `selectedTask` AND reasoning/phase overrides in one batch —
  // resetting after would wipe the values the prefill just populated).
  const prevSelectionRef = useRef(effectiveSelection);
  useEffect(() => {
    if (prevSelectionRef.current === effectiveSelection) return;
    prevSelectionRef.current = effectiveSelection;
    // Seeded state is intentional — leave it alone.
    if (sourceRun && sourceRunSeededRef.current === sourceRun.id) return;
    setReasoning(undefined);
    setPhaseOverrides({});
  }, [effectiveSelection, sourceRun]);

  const templateVars = useMemo(
    () => extractTemplateVars(activeTaskRow?.prompt),
    [activeTaskRow?.prompt],
  );

  const providerFromDraft: ProviderConfig | undefined = useMemo(() => {
    if (!isProviderDirty) return undefined;
    return draftToNormalizedProviderConfig(draft, availableModels);
  }, [draft, availableModels, isProviderDirty]);

  const harnessOverride: HarnessId | undefined = useMemo(() => {
    if (!isProviderDirty) return undefined;
    if (!draft.harness) return undefined;
    return draft.harness === taskDefaultHarness ? undefined : (draft.harness as HarnessId);
  }, [draft.harness, taskDefaultHarness, isProviderDirty]);

  const effectiveDefaults: EffectiveDefaults = useMemo(() => {
    const phaseDefs = activeTaskRow?.phases ?? [];
    return {
      harness: taskDefaultHarness,
      reasoningLevel: taskDefaultReasoning,
      model: taskDefaultModel || undefined,
      provider: taskDefaultProvider,
      phases: phaseDefs.map((p) => ({
        name: p.name,
        reasoningLevel: p.reasoningLevel,
        model: p.model,
        maxTurns: p.maxTurns,
      })),
    };
  }, [
    activeTaskRow?.phases,
    taskDefaultHarness,
    taskDefaultReasoning,
    taskDefaultModel,
    taskDefaultProvider,
  ]);

  const formState: OverridesFormState = useMemo(
    () => ({
      harness: harnessOverride,
      reasoningLevel: reasoning,
      model: undefined,
      provider: providerFromDraft,
      phases: phaseOverrides,
    }),
    [harnessOverride, reasoning, providerFromDraft, phaseOverrides],
  );

  const overrideCount = countOverrides(formState, effectiveDefaults);

  const resolvedHarness = harnessOverride ?? taskDefaultHarness;
  const resolvedReasoning = reasoning ?? taskDefaultReasoning;
  const resolvedProvider = providerFromDraft ?? taskDefaultProvider;
  const resolvedProviderType = resolvedProvider?.type ?? taskDefaultProviderType;
  const resolvedModel = resolveReasoningModel(
    resolvedReasoning,
    resolvedProvider,
    providerFromDraft?.model ?? taskDefaultModelFallback,
  );

  const rerunTaskMissing = sourceRun !== undefined
    && sourceRun.task !== null
    && !availableTasks.some((t) => t.name === sourceRun.task);
  const rerunBaseLabel = activeTaskRow
    ? taskLabel(activeTaskRow)
    : sourceRun?.task ?? '';
  const title = sourceRun
    ? (rerunTaskMissing
        ? `Rerun ${rerunBaseLabel} (task definition not found)`
        : `Rerun ${rerunBaseLabel}`)
    : preselectedTask
      ? `Run ${taskLabel(preselectedTask)}`
      : 'Trigger Agent Run';
  const description = sourceRun
    ? 'Starts a new run with the same settings as the source. The source run is untouched.'
    : preselectedTask
      ? undefined
      : 'Run the Myco agent now. It will process unprocessed sessions and update the vault.';

  function updateVar(name: string, value: string) {
    setVarValues((prev) => ({ ...prev, [name]: value }));
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

  function handleRun() {
    setRunNotice(null);
    const parts: string[] = [];
    for (const v of templateVars) {
      const val = varValues[v]?.trim();
      if (val) parts.push(`${v}: ${val}`);
    }
    const freeform = instruction.trim();
    if (freeform) parts.push(freeform);
    const fullInstruction = parts.length > 0 ? parts.join('\n') : undefined;

    const overrides = buildExecutionOverrides(formState, effectiveDefaults);

    triggerRun(
      {
        task: effectiveSelection || undefined,
        instruction: fullInstruction,
        ...(dryRun ? { dryRun: true } : {}),
        ...(effectiveSelection === SKILL_SURVEY_TASK ? { force: true } : {}),
        ...(overrides ? { executionOverrides: overrides } : {}),
      },
      {
        onSuccess: (data) => {
          if (data?.status === 'skipped' || !data?.runId) {
            setRunNotice(data?.message ?? 'Task skipped — no work to do.');
            return;
          }
          onOpenChange(false);
          onTriggered?.(data.runId);
        },
      },
    );
  }

  const phases = activeTaskRow?.phases ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Task picker (hidden when a task is preselected) */}
          {!preselectedTask && (
            <div className="space-y-1.5">
              <label className="font-sans text-sm font-medium text-on-surface">Task</label>
              {tasksLoading ? (
                <div className="flex h-9 items-center gap-2 text-on-surface-variant font-sans text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading tasks...
                </div>
              ) : (
                <Select value={effectiveSelection} onValueChange={setSelectedTask}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTasks.map((task) => (
                      <SelectItem key={task.name} value={task.name}>
                        {taskLabel(task)}
                        {task.isDefault && (
                          <span className="ml-1 font-sans text-xs text-on-surface-variant">
                            (default)
                          </span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* Rerun pre-fill notice — reassures the operator that this opens a
              new run, not an edit of the source. */}
          {sourceRun && (
            <div className="flex items-start gap-2 rounded-md bg-surface-container-lowest px-3 py-2 text-on-surface-variant">
              <RotateCcw className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <p className="font-sans text-xs">
                Pre-filled from run{' '}
                <span className="font-mono text-on-surface">{sourceRun.id.slice(0, 8)}</span>
                &hellip; &mdash; this will start a new run.
              </p>
            </div>
          )}

          {/* Summary — resolved execution */}
          {activeTaskRow && (
            <div className="rounded-md bg-surface-container-low p-3">
              <p className="font-sans text-xs text-on-surface-variant">Effective execution</p>
              <div className="mt-1 flex flex-wrap gap-4 font-mono text-xs text-on-surface">
                <span>harness: {resolvedHarness}</span>
                <span>provider: {resolvedProviderType}</span>
                {resolvedReasoning && <span>reasoning: {resolvedReasoning}</span>}
                {resolvedModel && <span>model: {resolvedModel}</span>}
              </div>
            </div>
          )}

          {/* Template variable inputs */}
          {templateVars.map((v, idx) => (
            <div key={v} className="space-y-1">
              <label className="font-sans text-sm font-medium text-on-surface">
                {varLabel(v)}
              </label>
              <Input
                value={varValues[v] ?? ''}
                onChange={(e) => updateVar(v, e.target.value)}
                placeholder={VAR_PLACEHOLDERS[v] ?? `Enter ${varLabel(v).toLowerCase()}`}
                className="font-mono"
                autoFocus={idx === 0}
              />
            </div>
          ))}

          {/* Free-form instruction */}
          <div className="space-y-1.5">
            <label className="font-sans text-sm font-medium text-on-surface">
              Instruction
              <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">
                (optional)
              </span>
            </label>
            <textarea
              className="w-full rounded-md bg-surface-container-lowest px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-hidden focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              rows={3}
              placeholder="Additional instructions for this run..."
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={isPending}
            />
          </div>

          {/* Collapsible per-run override editor */}
          {activeTaskRow && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setOverridesOpen((v) => !v)}
                className="flex items-center gap-2 font-sans text-sm font-medium text-on-surface hover:text-on-surface focus:outline-hidden focus:ring-2 focus:ring-primary/40 rounded"
              >
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${overridesOpen ? 'rotate-180' : ''}`}
                />
                Override execution for this run
                {overrideCount > 0 && (
                  <Badge variant="default" className="px-1.5 py-0 text-xs">
                    {overrideCount}
                  </Badge>
                )}
              </button>

              {overridesOpen && (
                <div className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low p-3">
                  <p className="font-sans text-xs text-on-surface-variant mb-4">
                    Customize provider, model, and reasoning without modifying the task definition.
                  </p>

                  <div className={phases.length > 0 ? 'grid gap-6 md:grid-cols-2' : 'space-y-4'}>
                    <div className="space-y-4">

                  <ProviderModelSelector
                    harness={draft.harness || taskDefaultHarness}
                    providerType={draft.type || ''}
                    localBackend={draft.localBackend}
                    model={draft.model}
                    baseUrl={draft.baseUrl}
                    contextLength={draft.contextLength}
                    modelPlaceholder={taskDefaultModel || undefined}
                    providers={providers}
                    isLoadingProviders={isLoadingProviders}
                    showHarnessSelector
                    onHarnessChange={handleDraftHarnessChange}
                    onProviderChange={handleDraftProviderChange}
                    onLocalBackendChange={handleDraftLocalBackendChange}
                    onModelChange={handleDraftModelChange}
                    onBaseUrlChange={handleDraftBaseUrlChange}
                    onContextLengthChange={handleDraftContextLengthChange}
                  />

                  <div className="space-y-1">
                    <label className="font-sans text-xs font-medium text-on-surface-variant">
                      Reasoning level
                    </label>
                    <Select
                      value={reasoning ?? TASK_DEFAULT_SENTINEL}
                      onValueChange={(val) =>
                        setReasoning(val === TASK_DEFAULT_SENTINEL ? undefined : (val as ReasoningLevel))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={TASK_DEFAULT_SENTINEL}>
                          Use task default ({taskDefaultReasoning ?? 'default'})
                        </SelectItem>
                        {REASONING_LEVELS.map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="font-sans text-[11px] text-on-surface-variant/70">
                      Maps to the provider's reasoning profile for this run only.
                    </p>
                  </div>

                  {overrideCount > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReasoning(undefined);
                        setPhaseOverrides({});
                        setProviderDraft({
                          harness: parseHarnessId(providerDraftDefaults.harness ?? 'claude-sdk') || 'claude-sdk',
                          type: parseProviderType(providerDraftDefaults.providerType ?? ''),
                          localBackend: providerDraftDefaults.localBackend ?? '',
                          model: providerDraftDefaults.model ?? '',
                          reasoningLow: providerDraftDefaults.reasoningMap?.low ?? '',
                          reasoningDefault: providerDraftDefaults.reasoningMap?.default ?? '',
                          reasoningHigh: providerDraftDefaults.reasoningMap?.high ?? '',
                          baseUrl: providerDraftDefaults.baseUrl ?? '',
                          contextLength: providerDraftDefaults.contextLength != null
                            ? String(providerDraftDefaults.contextLength)
                            : '',
                        });
                      }}
                      className="text-xs text-on-surface-variant"
                    >
                      Reset to task defaults
                    </Button>
                  )}
                    </div>

                    {phases.length > 0 && (
                      <div className="space-y-2">
                        <label className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                          Per-phase overrides
                        </label>
                        {phases.map((phase) => (
                          <PhaseConfigRow
                            key={phase.name}
                            phase={phase}
                            override={phaseOverrides[phase.name] ?? {}}
                            taskHarness={draft.harness || taskDefaultHarness}
                            taskProviderType={draft.type || taskDefaultProviderType}
                            taskModel={draft.model || taskDefaultModelFallback || ''}
                            taskReasoningMap={{
                              ...(taskDefaultProvider?.reasoning_map ?? {}),
                              ...(draft.reasoningLow ? { low: draft.reasoningLow } : {}),
                              ...(draft.reasoningDefault ? { default: draft.reasoningDefault } : {}),
                              ...(draft.reasoningHigh ? { high: draft.reasoningHigh } : {}),
                            }}
                            providers={providers}
                            isLoadingProviders={isLoadingProviders}
                            onChange={(update) => handlePhaseChange(phase.name, update)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Dry-run toggle */}
          <div className="flex items-start gap-2">
            <input
              id="run-task-dialog-dry-run"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={isPending}
              className="mt-0.5 h-4 w-4 rounded accent-primary"
            />
            <label htmlFor="run-task-dialog-dry-run" className="space-y-0.5">
              <span className="block font-sans text-sm font-medium text-on-surface">Dry run</span>
              <span className="block font-sans text-xs text-on-surface-variant">
                Intercept writes and record them as intents — no vault mutations.
              </span>
            </label>
          </div>

          {error && (
            <p className="font-sans text-xs text-tertiary">
              {error instanceof Error ? error.message : 'Failed to trigger run'}
            </p>
          )}

          {runNotice && (
            <p className="rounded-md bg-surface-container-low px-3 py-2 font-sans text-xs text-on-surface-variant">
              {runNotice}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" className="gap-2" onClick={handleRun} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                Run
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
