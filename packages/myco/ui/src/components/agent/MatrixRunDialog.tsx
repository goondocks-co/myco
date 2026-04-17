/**
 * MatrixRunDialog — the "Run matrix" entry point for the Comparisons tab.
 *
 * Fans a task across a cartesian product of (runtime × reasoning × model)
 * cells via POST /api/agent/evaluations. The resulting `evaluationId` is
 * then navigated to as `?tab=comparisons&eval=<id>`, where the matrix
 * view wraps the shared `<ComparisonView />`.
 *
 * Provider picker note: the picker here drives the model catalogue the
 * user chooses from (so the "Models" pill input auto-completes cleanly).
 * Backend-level provider pinning is deferred — the chosen provider
 * applies at matrix creation time via the `provider` being picked for
 * each cell, but the wire shape does not currently persist a top-level
 * matrix provider. See the product pivot notes.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Loader2, X } from 'lucide-react';
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
  useCreateEvaluation,
  type TaskRow,
} from '../../hooks/use-agent';
import { useProviderConfigDraft } from '../../hooks/use-provider-config-draft';
import {
  useProviders,
  type PhaseOverride,
} from '../../hooks/use-providers';
import { useTaskExecutionDefaults } from '../../hooks/use-task-execution-defaults';
import { useModels } from '../../hooks/use-models';
import type { RuntimeId, ReasoningLevel } from '@myco/agent/types';
import { buildMatrixPayload, computeCellCount } from './matrix-dialog-form';

const REASONING_OPTIONS: ReasoningLevel[] = ['low', 'default', 'high'];
const RUNTIME_OPTIONS: RuntimeId[] = ['claude-sdk', 'openai-agents'];

/** Above this cell count, surfaces an inline warning (not a hard block). */
const CELL_COUNT_WARN_THRESHOLD = 12;

/** Rough per-cell wall-clock in minutes for the warning copy. */
const ESTIMATED_MINUTES_PER_CELL = 3;

function taskLabel(task: TaskRow): string {
  return task.displayName ?? task.name;
}

export interface MatrixRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create with the new evaluation id. */
  onEvaluationCreated?: (evaluationId: string) => void;
}

export function MatrixRunDialog({
  open,
  onOpenChange,
  onEvaluationCreated,
}: MatrixRunDialogProps) {
  const [selectedTask, setSelectedTask] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [dryRun, setDryRun] = useState(false);

  const [matrixRuntimes, setMatrixRuntimes] = useState<RuntimeId[]>([]);
  const [matrixReasoning, setMatrixReasoning] = useState<ReasoningLevel[]>([]);
  const [matrixModels, setMatrixModels] = useState<string[]>([]);
  const [modelInput, setModelInput] = useState('');
  const [phaseOverrides, setPhaseOverrides] = useState<Record<string, PhaseOverride>>({});

  const { data: tasksData, isLoading: tasksLoading } = useAgentTasks();
  const { mutate: createEvaluation, isPending, error } = useCreateEvaluation();
  const { data: providersData, isPending: isLoadingProviders } = useProviders();
  const providers = providersData?.providers ?? [];

  const availableTasks: TaskRow[] = tasksData?.tasks ?? [];
  const defaultTask = availableTasks.find((t) => t.isDefault);
  const effectiveSelection = selectedTask
    ?? defaultTask?.name
    ?? availableTasks[0]?.name
    ?? '';

  const {
    taskRow: activeTaskRow,
    runtime: taskDefaultRuntime,
    provider: taskDefaultProvider,
    providerType: taskDefaultProviderType,
    modelFallback: taskDefaultModelFallback,
    draftSource: providerDraftSource,
    draftDefaults: providerDraftDefaults,
  } = useTaskExecutionDefaults(effectiveSelection || undefined);

  const {
    draft,
    handleRuntimeChange: handleDraftRuntimeChange,
    handleProviderChange: handleDraftProviderChange,
    handleModelChange: handleDraftModelChange,
    handleLocalBackendChange: handleDraftLocalBackendChange,
    handleBaseUrlChange: handleDraftBaseUrlChange,
    handleContextLengthChange: handleDraftContextLengthChange,
  } = useProviderConfigDraft({
    source: providerDraftSource,
    defaults: providerDraftDefaults,
    providers,
  });

  // Drive the Models pill-input autocomplete from the picked provider.
  const resolvedDraftBaseUrl = draft.baseUrl
    || providers.find((p) => p.type === draft.type)?.baseUrl
    || '';
  useModels(draft.type || null, resolvedDraftBaseUrl || undefined, 'llm', draft.localBackend || null);

  // Reset transient state when the dialog closes.
  useEffect(() => {
    if (!open) {
      setSelectedTask(undefined);
      setNotes('');
      setDryRun(false);
      setMatrixRuntimes([]);
      setMatrixReasoning([]);
      setMatrixModels([]);
      setModelInput('');
      setPhaseOverrides({});
    }
  }, [open]);

  const prevSelectionRef = useRef(effectiveSelection);
  useEffect(() => {
    if (prevSelectionRef.current === effectiveSelection) return;
    prevSelectionRef.current = effectiveSelection;
    setMatrixRuntimes([]);
    setMatrixReasoning([]);
    setMatrixModels([]);
    setModelInput('');
    setPhaseOverrides({});
  }, [effectiveSelection]);

  const cellCount = useMemo(
    () => computeCellCount({
      runtimes: matrixRuntimes,
      reasoningLevels: matrixReasoning,
      models: matrixModels,
    }),
    [matrixRuntimes, matrixReasoning, matrixModels],
  );
  const warning = cellCount > CELL_COUNT_WARN_THRESHOLD
    ? `${cellCount} cells — this may take ~${cellCount * ESTIMATED_MINUTES_PER_CELL} minutes.`
    : null;

  const phases = activeTaskRow?.phases ?? [];

  function toggleRuntime(runtime: RuntimeId) {
    setMatrixRuntimes((prev) =>
      prev.includes(runtime) ? prev.filter((r) => r !== runtime) : [...prev, runtime],
    );
  }
  function toggleReasoning(level: ReasoningLevel) {
    setMatrixReasoning((prev) =>
      prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level],
    );
  }
  function commitModelInput() {
    const trimmed = modelInput.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(',').map((t) => t.trim()).filter(Boolean);
    setMatrixModels((prev) => {
      const existing = new Set(prev);
      const next = [...prev];
      for (const tok of tokens) {
        if (!existing.has(tok)) {
          existing.add(tok);
          next.push(tok);
        }
      }
      return next;
    });
    setModelInput('');
  }
  function removeModel(model: string) {
    setMatrixModels((prev) => prev.filter((m) => m !== model));
  }
  function handlePhaseChange(phaseName: string, update: PhaseOverride | null) {
    setPhaseOverrides((prev) => {
      const next = { ...prev };
      if (update === null) delete next[phaseName];
      else next[phaseName] = update;
      return next;
    });
  }

  function handleSubmit() {
    if (!effectiveSelection) return;
    const matrix = buildMatrixPayload({
      runtimes: matrixRuntimes,
      reasoningLevels: matrixReasoning,
      models: matrixModels,
      dryRun,
      phases: phaseOverrides,
    });
    const trimmedNotes = notes.trim();
    createEvaluation(
      {
        taskId: effectiveSelection,
        matrix,
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
      },
      {
        onSuccess: (data) => {
          onOpenChange(false);
          onEvaluationCreated?.(data.evaluationId);
        },
      },
    );
  }

  const title = activeTaskRow
    ? `Run matrix: ${taskLabel(activeTaskRow)}`
    : 'Run matrix';
  const description =
    'Fan this task across multiple runtime, reasoning, or model variants — each cell runs independently and the result appears as a comparison.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Task picker */}
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

          {/* Provider picker (required — single provider, varying models) */}
          {activeTaskRow && (
            <div className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low p-3 space-y-2">
              <p className="font-sans text-xs text-on-surface-variant">
                Provider (applies to every cell). Model variants must be valid for this provider.
              </p>
              <ProviderModelSelector
                runtime={draft.runtime || taskDefaultRuntime}
                providerType={draft.type || ''}
                localBackend={draft.localBackend}
                model={draft.model}
                baseUrl={draft.baseUrl}
                contextLength={draft.contextLength}
                modelPlaceholder={taskDefaultModelFallback || undefined}
                providers={providers}
                isLoadingProviders={isLoadingProviders}
                showRuntimeSelector
                onRuntimeChange={handleDraftRuntimeChange}
                onProviderChange={handleDraftProviderChange}
                onLocalBackendChange={handleDraftLocalBackendChange}
                onModelChange={handleDraftModelChange}
                onBaseUrlChange={handleDraftBaseUrlChange}
                onContextLengthChange={handleDraftContextLengthChange}
              />
            </div>
          )}

          {/* Summary — cell count */}
          {activeTaskRow && (
            <div className="rounded-md bg-surface-container-low p-3">
              <p className="font-sans text-xs text-on-surface-variant">Matrix</p>
              <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-xs text-on-surface">
                <span>{matrixRuntimes.length || 1} runtimes</span>
                <span className="text-on-surface-variant">×</span>
                <span>{matrixReasoning.length || 1} reasoning</span>
                <span className="text-on-surface-variant">×</span>
                <span>{matrixModels.length || 1} models</span>
                <span className="text-on-surface-variant">=</span>
                <span className="font-semibold">{cellCount} {cellCount === 1 ? 'cell' : 'cells'}</span>
              </div>
              {warning && (
                <p className="mt-1.5 font-sans text-xs text-tertiary">{warning}</p>
              )}
            </div>
          )}

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="font-sans text-sm font-medium text-on-surface">
              Notes
              <span className="ml-1 font-sans text-xs text-on-surface-variant font-normal">
                (optional)
              </span>
            </label>
            <textarea
              className="w-full rounded-md bg-surface-container-lowest px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 resize-none"
              rows={3}
              placeholder="Why you are running this comparison (shown on the comparison detail page)..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isPending}
            />
          </div>

          {/* Dimensions */}
          {activeTaskRow && (
            <div className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low p-3">
              <p className="font-sans text-xs text-on-surface-variant mb-3">
                Pick values for each dimension you want to vary. Leave a dimension empty to use the task default for that axis.
              </p>

              <div className={phases.length > 0 ? 'grid gap-6 md:grid-cols-2' : 'space-y-4'}>
                <div className="space-y-4">
                  {/* Runtimes */}
                  <div className="space-y-1.5">
                    <label className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                      Runtimes
                    </label>
                    <div className="flex flex-wrap gap-3">
                      {RUNTIME_OPTIONS.map((rt) => (
                        <label
                          key={rt}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-on-surface cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={matrixRuntimes.includes(rt)}
                            onChange={() => toggleRuntime(rt)}
                            disabled={isPending}
                            className="h-3.5 w-3.5 rounded accent-primary"
                          />
                          {rt}
                        </label>
                      ))}
                    </div>
                    <p className="font-sans text-[11px] text-on-surface-variant/70">
                      Empty = run with the task default runtime only.
                    </p>
                  </div>

                  {/* Reasoning levels */}
                  <div className="space-y-1.5">
                    <label className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                      Reasoning
                    </label>
                    <div className="flex flex-wrap gap-3">
                      {REASONING_OPTIONS.map((lvl) => (
                        <label
                          key={lvl}
                          className="inline-flex items-center gap-1.5 font-mono text-xs text-on-surface cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={matrixReasoning.includes(lvl)}
                            onChange={() => toggleReasoning(lvl)}
                            disabled={isPending}
                            className="h-3.5 w-3.5 rounded accent-primary"
                          />
                          {lvl}
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Models — pill input */}
                  <div className="space-y-1.5">
                    <label className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                      Models
                    </label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {matrixModels.map((m) => (
                        <span
                          key={m}
                          className="inline-flex items-center gap-1 rounded-full bg-surface-container-high px-2 py-0.5 font-mono text-xs text-on-surface"
                        >
                          {m}
                          <button
                            type="button"
                            onClick={() => removeModel(m)}
                            disabled={isPending}
                            aria-label={`Remove ${m}`}
                            className="text-on-surface-variant hover:text-on-surface focus:outline-none"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                    <Input
                      value={modelInput}
                      onChange={(e) => setModelInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          commitModelInput();
                        }
                      }}
                      onBlur={() => commitModelInput()}
                      placeholder="claude-sonnet-4-5, claude-haiku-4-5 (Enter to add)"
                      disabled={isPending}
                      className="font-mono text-xs"
                    />
                    <p className="font-sans text-[11px] text-on-surface-variant/70">
                      Free-text names — must be valid for the provider picked above.
                    </p>
                  </div>
                </div>

                {/* Per-phase overrides shared across all cells */}
                {phases.length > 0 && (
                  <div className="space-y-2">
                    <label className="font-sans text-xs font-medium text-on-surface-variant uppercase tracking-wide">
                      Per-phase overrides (shared across cells)
                    </label>
                    {phases.map((phase) => (
                      <PhaseConfigRow
                        key={phase.name}
                        phase={phase}
                        override={phaseOverrides[phase.name] ?? {}}
                        taskRuntime={taskDefaultRuntime}
                        taskProviderType={taskDefaultProviderType}
                        taskModel={taskDefaultModelFallback || ''}
                        taskReasoningMap={taskDefaultProvider?.reasoning_map ?? {}}
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

          {/* Dry-run toggle */}
          <div className="flex items-start gap-2">
            <input
              id="matrix-run-dialog-dry-run"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={isPending}
              className="mt-0.5 h-4 w-4 rounded accent-primary"
            />
            <label htmlFor="matrix-run-dialog-dry-run" className="space-y-0.5">
              <span className="block font-sans text-sm font-medium text-on-surface">Dry run</span>
              <span className="block font-sans text-xs text-on-surface-variant">
                Intercept writes on every cell — no vault mutations.
              </span>
            </label>
          </div>

          {error && (
            <p className="font-sans text-xs text-tertiary">
              {error instanceof Error ? error.message : 'Failed to create evaluation'}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" className="gap-2" onClick={handleSubmit} disabled={isPending || !effectiveSelection}>
            {isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Layers className="h-3.5 w-3.5" />
                Create matrix
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
