/**
 * ComparisonView — the shared comparison surface.
 *
 * Renders an aggregate row, a drift annotation banner, a deltas summary,
 * and the per-run comparison table over an arbitrary set of runs. Used by
 * both the "Compare selected runs" flow off the Runs list and the matrix
 * evaluation detail view (`EvaluationDetail` wraps this component with its
 * evaluation-specific metadata).
 *
 * Intentionally free of matrix / evaluation vocabulary — this is a
 * general-purpose "compare N runs" view. The runs come from
 * `useRunsByIds(...)` when ad-hoc, or from an evaluation's child run list
 * when matrix-sourced.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Surface } from '../ui/surface';
import { StatCard } from '../ui/stat-card';
import { useAgentTasks, type EvaluationRunSummary } from '../../hooks/use-agent';
import { formatDurationMs, capitalize } from '../../lib/format';
import { formatCost, formatTokens, statusBadgeVariant } from './helpers';
import {
  TASK_DEFAULT_LABEL,
  DRIFT_THRESHOLD_MINUTES,
  aggregateRunSet,
  deriveRunReasoning,
  computeCostPerWrite,
  computeDeltas,
  detectDrift,
  detectSharedInputs,
  formatDriftDuration,
  formatWriteIntentsByTool,
  sumPhaseTurns,
  selectVisibleColumns,
  buildPhaseBreakdown,
  countPhaseOverrides,
  formatPhaseOverrideTooltip,
  type ColumnKey,
  type PhaseBreakdownRow,
  type RunSetAggregate,
} from './evaluation-helpers';

/* ---------- Types ---------- */

export interface ComparisonViewProps {
  /** Runs to display. May be empty while underlying fetch is pending. */
  runs: EvaluationRunSummary[];
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  /** Called when the back affordance is clicked. */
  onBack: () => void;
  /** Called when a row's "View run" link is clicked. */
  onOpenRun: (runId: string) => void;
  /** Override for the header title (default: "Comparison"). */
  title?: string;
  /** Override for the header subtitle (default: "{N} runs"). */
  subtitle?: string;
  /**
   * Optional aggregate to render in the stat cards. When omitted the view
   * computes one from the run set. Evaluation-backed comparisons pass the
   * daemon-computed aggregate; ad-hoc run comparisons let the view derive
   * its own.
   */
  aggregate?: RunSetAggregate;
  /**
   * Evaluation-specific metadata slot rendered between the header and the
   * aggregate row. `EvaluationDetail` uses this to show matrix dimensions
   * + evaluation status. Left undefined in ad-hoc comparisons.
   */
  metadataSlot?: React.ReactNode;
  /** Label for the back button (default: "Back"). */
  backLabel?: string;
}

/**
 * Candidate columns presented in the comparison table — matches the
 * `<thead>` order below. `selectVisibleColumns` filters this list when the
 * diff-only toggle is on.
 */
const COLUMN_ORDER: readonly ColumnKey[] = [
  'runtime',
  'reasoning',
  'model',
  'status',
  'turns',
  'tokens',
  'cost',
  'duration',
  'writes',
  'costPerWrite',
];

const COLUMN_LABELS: Record<ColumnKey, string> = {
  runtime: 'Runtime',
  reasoning: 'Reasoning',
  model: 'Model',
  status: 'Status',
  turns: 'Turns',
  tokens: 'Tokens',
  cost: 'Cost',
  duration: 'Duration',
  writes: 'Writes',
  costPerWrite: '$/write',
};

/** Tightest char budget we'll tolerate in the same-input badge value. */
const SHARED_INPUT_VALUE_MAX = 32;

/* ---------- Component ---------- */

export function ComparisonView({
  runs,
  isLoading,
  isError,
  errorMessage,
  onBack,
  onOpenRun,
  title = 'Comparison',
  subtitle,
  aggregate,
  metadataSlot,
  backLabel = 'Back',
}: ComparisonViewProps) {
  // Compute aggregate client-side when the caller doesn't provide one.
  const effectiveAggregate = useMemo(
    () => aggregate ?? aggregateRunSet(runs),
    [aggregate, runs],
  );

  const reasoningArr = useMemo(
    () => runs.map((run) => deriveRunReasoning(run)),
    [runs],
  );

  const deltas = useMemo(
    () => computeDeltas(runs, reasoningArr),
    [runs, reasoningArr],
  );

  const drift = useMemo(() => detectDrift(runs), [runs]);
  const sharedInputs = useMemo(() => detectSharedInputs(runs), [runs]);

  // Resolve task display names so the header can show "Task: Title & Summary"
  // instead of the raw task id. `useAgentTasks` is lightweight (TanStack Query
  // with a generous stale time) — safe to call from this shared component.
  const { data: tasksData } = useAgentTasks();
  const taskDisplayNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasksData?.tasks ?? []) {
      map.set(task.name, task.displayName);
    }
    return map;
  }, [tasksData]);

  const taskContext = useMemo(() => summarizeTaskContext(runs, taskDisplayNameMap), [runs, taskDisplayNameMap]);

  // Diff-only toggle state — off by default so new visitors see every column.
  const [diffOnly, setDiffOnly] = useState(false);

  // Expanded-row set keyed by run id. Multi-expand allowed for side-by-side
  // phase-breakdown comparison.
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((runId: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  const visibleColumns = useMemo(
    () => (diffOnly ? selectVisibleColumns(runs, COLUMN_ORDER) : new Set<ColumnKey>(COLUMN_ORDER)),
    [diffOnly, runs],
  );

  const anyPhaseOverrides = useMemo(
    () => runs.some((run) => countPhaseOverrides(run) > 0),
    [runs],
  );

  if (isLoading && runs.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans">Loading runs...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
          <ArrowLeft className="h-4 w-4" />
          {backLabel}
        </Button>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-tertiary">
          <AlertCircle className="h-5 w-5" />
          <span className="font-sans text-sm">Failed to load runs</span>
          {errorMessage && (
            <span className="font-sans text-xs text-on-surface-variant">{errorMessage}</span>
          )}
        </div>
      </div>
    );
  }

  const showDeltas = runs.length > 1;
  const showDiffToggle = runs.length > 1;
  const resolvedSubtitle = subtitle ?? `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`;
  // +1 column for the chevron, +1 for the "View run" action column.
  const tableColSpan = visibleColumns.size + 2;

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button variant="ghost" size="sm" onClick={onBack} className="gap-2 text-on-surface-variant">
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Button>

      {/* Header */}
      <div className="space-y-1">
        <h1 className="font-serif text-xl text-on-surface">{title}</h1>
        {resolvedSubtitle && (
          <p className="font-sans text-sm text-on-surface-variant">{resolvedSubtitle}</p>
        )}
      </div>

      {/* Elevated drift banner — always visible above the metadata/aggregate
          row when the run set spans enough vault-activity time to matter. */}
      {drift.show && drift.spanMinutes > DRIFT_THRESHOLD_MINUTES && (
        <Surface level="low" className="flex items-start gap-2 p-3 border border-outline-variant/40">
          <AlertTriangle className="h-4 w-4 mt-0.5 text-secondary shrink-0" aria-hidden />
          <div className="font-sans text-sm text-on-surface-variant">
            Runs span {formatDriftDuration(drift.spanMinutes)} of vault activity — results may
            reflect different vault states. Consider running with the same input (session_id,
            batch_id) for apples-to-apples comparison.
          </div>
        </Surface>
      )}

      {/* Task + shared-input context row — surfaces what's being compared */}
      {(taskContext.kind !== 'none' || sharedInputs.sameInput !== null) && (
        <div className="flex flex-wrap items-center gap-2">
          {taskContext.kind === 'single' && (
            <Badge variant="outline" className="text-xs">
              Task: {taskContext.label}
            </Badge>
          )}
          {taskContext.kind === 'mixed' && (
            <>
              <Badge variant="warning" className="text-xs" title={taskContext.tooltip}>
                Tasks: {taskContext.count}
              </Badge>
              <span className="inline-flex items-center gap-1 font-sans text-xs text-on-surface-variant">
                <AlertTriangle className="h-3 w-3 inline" aria-hidden />
                Runs span multiple tasks — mechanical metrics are still comparable but output
                semantics differ.
              </span>
            </>
          )}
          {sharedInputs.sameInput === true && (
            <Badge
              variant="default"
              className="gap-1 text-xs"
              title={formatInputsTooltip(sharedInputs.inputs)}
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Same input: {formatInputsBadge(sharedInputs.inputs)}
            </Badge>
          )}
          {sharedInputs.sameInput === false && (
            <Badge variant="warning" className="gap-1 text-xs">
              <AlertTriangle className="h-3 w-3 inline" aria-hidden />
              Different inputs — each run targeted different data
            </Badge>
          )}
        </div>
      )}

      {metadataSlot}

      {/* Aggregate stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard label="Runs" value={String(effectiveAggregate.total)} accent="outline" />
        <StatCard label="Completed" value={String(effectiveAggregate.completed)} accent="sage" />
        <StatCard label="Failed" value={String(effectiveAggregate.failed)} accent="terracotta" />
        <StatCard label="Skipped" value={String(effectiveAggregate.skipped)} accent="outline" />
        <StatCard label="Tokens" value={formatTokens(effectiveAggregate.totalTokens)} accent="ochre" />
        <StatCard label="Cost" value={formatCost(effectiveAggregate.totalCostUsd, 'actual')} accent="ochre" />
      </div>

      {/* Deltas row — hidden in single-run degenerate case */}
      {showDeltas && (
        <div className="flex flex-wrap gap-2">
          {deltas.cheapest ? (
            <DeltaChip
              label="Cheapest"
              cell={deltas.cheapest.label}
              value={`${formatCost(deltas.cheapest.run.cost_usd, 'actual')}${deltas.cheapestPct !== null ? ` (${deltas.cheapestPct}% of most expensive)` : ''}`}
            />
          ) : null}
          {deltas.mostWrites ? (
            <DeltaChip
              label="Most writes"
              cell={deltas.mostWrites.label}
              value={`${deltas.mostWrites.run.write_intents.total} intents`}
            />
          ) : null}
          {deltas.fastest ? (
            <DeltaChip
              label="Fastest"
              cell={deltas.fastest.label}
              value={formatDurationMs(deltas.fastest.run.duration_ms)}
            />
          ) : null}
        </div>
      )}

      {/* Phase-override hint — only when at least one run has phase overrides. */}
      {anyPhaseOverrides && (
        <p className="font-sans text-xs italic text-on-surface-variant">
          Some runs use phase-level overrides — expand rows to see per-phase differences.
        </p>
      )}

      {/* Comparison table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="font-sans text-sm font-medium text-on-surface-variant uppercase tracking-wide">
            Run comparison
          </h2>
          {showDiffToggle && (
            <Button
              variant={diffOnly ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setDiffOnly((v) => !v)}
              className="gap-2 text-xs"
              aria-pressed={diffOnly}
            >
              Show only varying dimensions
            </Button>
          )}
        </div>
        {runs.length === 0 ? (
          <Surface level="low" className="flex h-24 items-center justify-center">
            <span className="font-sans text-sm text-on-surface-variant">
              {isLoading ? 'Loading runs...' : 'No runs to compare'}
            </span>
          </Surface>
        ) : (
          <div className="rounded-md bg-surface-container-low overflow-x-auto">
            <table className="w-full" aria-label="Run comparison">
              <thead>
                <tr className="border-b border-outline-variant/20 bg-surface-container/50">
                  <HeaderCell>{/* chevron column */}</HeaderCell>
                  {COLUMN_ORDER.filter((c) => visibleColumns.has(c)).map((column) => (
                    <HeaderCell key={column}>{COLUMN_LABELS[column]}</HeaderCell>
                  ))}
                  <HeaderCell>{''}</HeaderCell>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <ComparisonRow
                    key={run.id}
                    run={run}
                    expanded={expandedRuns.has(run.id)}
                    onToggleExpanded={toggleExpanded}
                    onOpenRun={onOpenRun}
                    visibleColumns={visibleColumns}
                    colSpan={tableColSpan}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function HeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-[11px] font-medium text-on-surface-variant uppercase tracking-widest font-sans whitespace-nowrap">
      {children}
    </th>
  );
}

interface ComparisonRowProps {
  run: EvaluationRunSummary;
  expanded: boolean;
  onToggleExpanded: (runId: string) => void;
  onOpenRun: (runId: string) => void;
  visibleColumns: Set<ColumnKey>;
  colSpan: number;
}

const ComparisonRow = memo(function ComparisonRow({
  run,
  expanded,
  onToggleExpanded,
  onOpenRun,
  visibleColumns,
  colSpan,
}: ComparisonRowProps) {
  const derived = useMemo(() => ({
    turnsTotal: sumPhaseTurns(run.usage_data),
    costPerWrite: computeCostPerWrite(run.cost_usd, run.write_intents.total),
    byToolLabel: formatWriteIntentsByTool(run.write_intents.by_tool),
    reasoning: deriveRunReasoning(run),
    phaseOverrideCount: countPhaseOverrides(run),
    phaseOverrideTooltip: formatPhaseOverrideTooltip(run),
  }), [run]);

  const phaseRows = useMemo(
    () => (expanded ? buildPhaseBreakdown(run) : []),
    [expanded, run],
  );

  const handleToggle = useCallback(() => onToggleExpanded(run.id), [onToggleExpanded, run.id]);
  const handleOpen = useCallback(() => onOpenRun(run.id), [onOpenRun, run.id]);

  return (
    <>
      <tr className="border-b border-outline-variant/10 last:border-0 hover:bg-surface-container-high/40 transition-colors">
        <Cell>
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse phase breakdown' : 'Expand phase breakdown'}
            className="flex items-center justify-center text-on-surface-variant hover:text-on-surface transition-colors"
          >
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </Cell>
        {visibleColumns.has('runtime') && (
          <Cell>{run.runtime || <DefaultSentinel />}</Cell>
        )}
        {visibleColumns.has('reasoning') && (
          <Cell>
            {derived.reasoning === TASK_DEFAULT_LABEL ? <DefaultSentinel /> : derived.reasoning}
          </Cell>
        )}
        {visibleColumns.has('model') && (
          <Cell>
            <div className="flex items-center gap-2">
              <span>{run.model || <DefaultSentinel />}</span>
              {derived.phaseOverrideCount > 0 && (
                <Badge
                  variant="secondary"
                  className="text-[10px]"
                  title={derived.phaseOverrideTooltip || undefined}
                >
                  Phases: {derived.phaseOverrideCount}
                </Badge>
              )}
            </div>
          </Cell>
        )}
        {visibleColumns.has('status') && (
          <Cell>
            <Badge variant={statusBadgeVariant(run.status)}>{capitalize(run.status)}</Badge>
          </Cell>
        )}
        {visibleColumns.has('turns') && (
          <Cell>{derived.turnsTotal === null ? '\u2014' : derived.turnsTotal}</Cell>
        )}
        {visibleColumns.has('tokens') && (
          <Cell>{formatTokens(run.tokens_used)}</Cell>
        )}
        {visibleColumns.has('cost') && (
          <Cell>{formatCost(run.cost_usd, 'actual')}</Cell>
        )}
        {visibleColumns.has('duration') && (
          <Cell>{formatDurationMs(run.duration_ms)}</Cell>
        )}
        {visibleColumns.has('writes') && (
          <Cell>
            <div className="flex flex-col gap-0.5">
              <span>{run.write_intents.total}</span>
              {derived.byToolLabel && (
                <span className="font-sans text-[10px] text-on-surface-variant">{derived.byToolLabel}</span>
              )}
            </div>
          </Cell>
        )}
        {visibleColumns.has('costPerWrite') && (
          <Cell>{derived.costPerWrite === null ? '\u2014' : `$${derived.costPerWrite.toFixed(4)}`}</Cell>
        )}
        <Cell>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 h-7 text-on-surface-variant"
            onClick={handleOpen}
          >
            <ExternalLink className="h-3 w-3" />
            View run
          </Button>
        </Cell>
      </tr>
      {expanded && (
        <tr className="bg-surface-container/30 border-b border-outline-variant/10 last:border-0">
          <td colSpan={colSpan} className="px-3 py-3">
            <PhaseBreakdownTable phases={phaseRows} />
          </td>
        </tr>
      )}
    </>
  );
}, (prev, next) => (
  prev.run === next.run
  && prev.expanded === next.expanded
  && prev.visibleColumns === next.visibleColumns
  && prev.colSpan === next.colSpan
  && prev.onToggleExpanded === next.onToggleExpanded
  && prev.onOpenRun === next.onOpenRun
));

function PhaseBreakdownTable({ phases }: { phases: PhaseBreakdownRow[] }) {
  if (phases.length === 0) {
    return (
      <span className="font-sans text-xs text-on-surface-variant italic">
        No phase data available.
      </span>
    );
  }
  return (
    <div className="rounded-xs bg-surface-container-low/60 overflow-x-auto">
      <table className="w-full" aria-label="Phase breakdown">
        <thead>
          <tr className="border-b border-outline-variant/20">
            <HeaderCell>Phase</HeaderCell>
            <HeaderCell>Reasoning</HeaderCell>
            <HeaderCell>Model</HeaderCell>
            <HeaderCell>Turns</HeaderCell>
            <HeaderCell>Tokens</HeaderCell>
            <HeaderCell>Cost</HeaderCell>
            <HeaderCell>Duration</HeaderCell>
          </tr>
        </thead>
        <tbody>
          {phases.map((phase) => (
            <tr
              key={phase.name}
              className="border-b border-outline-variant/10 last:border-0"
            >
              <Cell>{phase.name}</Cell>
              <Cell>{phase.reasoning ?? <DefaultSentinel />}</Cell>
              <Cell>{phase.model ?? <DefaultSentinel />}</Cell>
              <Cell>{phase.turnsUsed === null ? '\u2014' : phase.turnsUsed}</Cell>
              <Cell>{formatTokens(phase.tokensUsed)}</Cell>
              <Cell>{formatCost(phase.costUsd, 'actual')}</Cell>
              <Cell>{formatDurationMs(phase.durationMs)}</Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cell({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3 py-2 font-mono text-xs text-on-surface whitespace-nowrap">
      {children}
    </td>
  );
}

function DefaultSentinel() {
  return (
    <span className="font-sans text-[11px] italic text-on-surface-variant">
      {TASK_DEFAULT_LABEL}
    </span>
  );
}

/**
 * Summarize the task(s) a run set is comparing, resolving each run's `task`
 * field against the daemon-provided display-name map. Returns a
 * discriminated union:
 *   - `{ kind: 'none' }` — no runs, or every run has a null task
 *   - `{ kind: 'single', label }` — every non-null run shares one task
 *   - `{ kind: 'mixed', count, tooltip }` — multiple distinct tasks
 */
type TaskContext =
  | { kind: 'none' }
  | { kind: 'single'; label: string }
  | { kind: 'mixed'; count: number; tooltip: string };

function summarizeTaskContext(
  runs: ReadonlyArray<Pick<EvaluationRunSummary, 'task'>>,
  displayNames: Map<string, string>,
): TaskContext {
  const distinct = new Set<string>();
  for (const run of runs) {
    if (run.task) distinct.add(run.task);
  }
  if (distinct.size === 0) return { kind: 'none' };
  if (distinct.size === 1) {
    const [only] = distinct;
    return { kind: 'single', label: displayNames.get(only) ?? only };
  }
  const names = [...distinct].map((id) => displayNames.get(id) ?? id).sort();
  return { kind: 'mixed', count: distinct.size, tooltip: names.join(', ') };
}

/**
 * Render the same-input value badge text. Single-pair maps render as
 * `key=value`; multi-pair maps are joined with commas. Values are truncated
 * to keep the badge from dominating the row.
 */
function formatInputsBadge(inputs: Record<string, string | undefined>): string {
  const entries = Object.entries(inputs).filter((e): e is [string, string] => Boolean(e[1]));
  if (entries.length === 0) return '';
  return entries.map(([k, v]) => `${k}=${truncateInputValue(v)}`).join(', ');
}

/** Full `key=value` tooltip without truncation so the untruncated value is accessible. */
function formatInputsTooltip(inputs: Record<string, string | undefined>): string {
  return Object.entries(inputs)
    .filter((e): e is [string, string] => Boolean(e[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function truncateInputValue(value: string): string {
  if (value.length <= SHARED_INPUT_VALUE_MAX) return value;
  return `${value.slice(0, SHARED_INPUT_VALUE_MAX - 1)}…`;
}

function DeltaChip({
  label,
  cell,
  value,
}: {
  label: string;
  cell: string;
  value: string;
}) {
  return (
    <Surface level="low" className="px-3 py-2 flex items-center gap-2 text-xs">
      <span className="font-sans font-medium text-on-surface-variant uppercase tracking-wide text-[10px]">
        {label}
      </span>
      <span className="font-mono text-on-surface">{cell}</span>
      <span className="font-mono text-on-surface-variant">— {value}</span>
    </Surface>
  );
}
