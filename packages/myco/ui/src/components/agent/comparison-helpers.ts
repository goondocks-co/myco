/**
 * Pure helpers backing the shared `ComparisonView` component.
 *
 * Extracted to a standalone module so they can be unit-tested without
 * spinning up a React renderer (the component itself has no RTL harness).
 */

import { tryParseJson } from '@myco/utils/json';
import type { RunCompareSummary } from '../../hooks/use-agent';
import { extractSharedInputs, type SharedInputKey } from './shared-inputs';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * Sentinel rendered in cells (not headers) when a dimension was left
 * unspecified — i.e. the run inherited the task's default for that axis.
 */
export const TASK_DEFAULT_LABEL = '(task default)';

// ---------------------------------------------------------------------------
// Per-run reasoning resolution
// ---------------------------------------------------------------------------

/**
 * Derive the display-reasoning for a single run, reading directly from the
 * persisted `run.reasoning_level` column. Returns `TASK_DEFAULT_LABEL` when
 * the column is null — i.e. the run inherited the task default (no override
 * applied at submit time).
 */
export function deriveRunReasoning(
  run: Pick<RunCompareSummary, 'reasoning_level'>,
): string {
  return run.reasoning_level ?? TASK_DEFAULT_LABEL;
}

// ---------------------------------------------------------------------------
// Cell label derivation
// ---------------------------------------------------------------------------

export interface CellLabelInput {
  runtime: string | null | undefined;
  reasoningLevel: string | null | undefined;
  model: string | null | undefined;
}

/**
 * Build a compact human label for a cell from its (runtime, reasoning,
 * model) triple. Omits any dimension that resolves to the task default so
 * single-axis matrices read cleanly. Returns `"default"` when every axis
 * defaulted (the single-cell degenerate case).
 *
 * Defaults include literal nulls/undefined, empty strings, and the explicit
 * `TASK_DEFAULT_LABEL` sentinel.
 */
export function deriveCellLabel(input: CellLabelInput): string {
  const parts: string[] = [];
  if (isConcrete(input.runtime)) parts.push(String(input.runtime));
  if (isConcrete(input.reasoningLevel)) parts.push(String(input.reasoningLevel));
  if (isConcrete(input.model)) parts.push(String(input.model));
  if (parts.length === 0) return 'default';
  return parts.join(' / ');
}

function isConcrete(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (value === '') return false;
  if (value === TASK_DEFAULT_LABEL) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Cost-per-write derivation
// ---------------------------------------------------------------------------

/**
 * Compute cost-per-write-intent for a cell as `cost_usd / write_intents.total`
 * rounded to 4 decimals. Returns `null` when cost is null/missing or when the
 * run produced zero intents (division-by-zero guard) — the caller renders a
 * visible em dash in that case.
 */
export function computeCostPerWrite(
  costUsd: number | null | undefined,
  writeCount: number,
): number | null {
  if (costUsd === null || costUsd === undefined) return null;
  if (!Number.isFinite(costUsd)) return null;
  if (writeCount <= 0) return null;
  return Math.round((costUsd / writeCount) * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Deltas summary
// ---------------------------------------------------------------------------

export interface DeltaCell {
  /** The run that won this category (lowest cost / most writes / fastest). */
  run: RunCompareSummary;
  /** Human-friendly label for the cell (runtime / reasoning / model). */
  label: string;
}

export interface DeltasSummary {
  cheapest: DeltaCell | null;
  /** Percent of the most expensive run's cost, as an integer 0–100. */
  cheapestPct: number | null;
  mostWrites: DeltaCell | null;
  fastest: DeltaCell | null;
}

/**
 * Find the winning cell for each of three comparison dimensions: cheapest,
 * most writes, and fastest. Each returns `null` when no cell has a usable
 * value for the dimension (e.g. every run has `cost_usd === null`).
 *
 * Tie-break is "first wins" — stable ordering of runs preserves it.
 */
export function computeDeltas(
  runs: RunCompareSummary[],
  reasoningByIndex: Array<string | undefined>,
): DeltasSummary {
  let cheapest: DeltaCell | null = null;
  let highestCost: number | null = null;
  let mostWrites: DeltaCell | null = null;
  let fastest: DeltaCell | null = null;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const label = deriveCellLabel({
      runtime: run.runtime,
      reasoningLevel: reasoningByIndex[i],
      model: run.model,
    });

    // Cheapest — skip runs without a concrete cost.
    if (run.cost_usd !== null && run.cost_usd !== undefined && Number.isFinite(run.cost_usd)) {
      if (cheapest === null || run.cost_usd < cheapest.run.cost_usd!) {
        cheapest = { run, label };
      }
      if (highestCost === null || run.cost_usd > highestCost) {
        highestCost = run.cost_usd;
      }
    }

    // Most writes — skip runs with zero intents (would tie meaninglessly).
    const writeTotal = run.write_intents?.total ?? 0;
    if (writeTotal > 0) {
      if (mostWrites === null || writeTotal > (mostWrites.run.write_intents?.total ?? 0)) {
        mostWrites = { run, label };
      }
    }

    // Fastest — require a concrete duration.
    if (run.duration_ms !== null && run.duration_ms !== undefined && Number.isFinite(run.duration_ms)) {
      if (fastest === null || run.duration_ms < fastest.run.duration_ms!) {
        fastest = { run, label };
      }
    }
  }

  const cheapestPct =
    cheapest && highestCost !== null && highestCost > 0
      ? Math.round(((cheapest.run.cost_usd ?? 0) / highestCost) * 100)
      : null;

  return { cheapest, cheapestPct, mostWrites, fastest };
}

// ---------------------------------------------------------------------------
// By-tool formatting
// ---------------------------------------------------------------------------

/**
 * Format a `{ toolName: count }` map as a compact subcaption:
 *   `spore×4, proc×1, state×1`
 *
 * Tool names are shortened to a trailing token (everything after the last
 * `_`) so `vault_create_spore` → `spore`, `vault_write_skill` → `skill`.
 * When the shortened form collides we fall back to the full name. Empty
 * input returns an empty string.
 */
export function formatWriteIntentsByTool(byTool: Record<string, number>): string {
  const entries = Object.entries(byTool);
  if (entries.length === 0) return '';

  // Sort by count desc so the biggest bucket leads; stable by tool name.
  entries.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

  return entries.map(([name, count]) => `${shortenToolName(name)}×${count}`).join(', ');
}

function shortenToolName(name: string): string {
  const parts = name.split('_');
  if (parts.length <= 1) return name;
  const tail = parts[parts.length - 1];
  // Very short tails (e.g. "up" from a hypothetical "vault_sync_up") are
  // ambiguous — keep the full name in that case.
  if (tail.length < 3) return name;
  return tail;
}

// ---------------------------------------------------------------------------
// Phase-turn aggregation
// ---------------------------------------------------------------------------

/**
 * Sum per-phase turnsUsed from a run's `usage_data` JSON blob. Returns
 * `null` when the field is missing, unparseable, or has no phases — the
 * caller renders an em dash in that case.
 *
 * Kept here (rather than crossing into the phase-audit service) because it
 * needs to read the raw JSON the daemon hands back without a round-trip
 * through the audit endpoint.
 */
function isObjectWithPhases(value: unknown): value is { phases?: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sumPhaseTurns(usageData: string | null): number | null {
  const parsed = tryParseJson(usageData, isObjectWithPhases);
  const phases = parsed?.phases as Array<{ turnsUsed?: number }> | undefined;
  if (!Array.isArray(phases) || phases.length === 0) return null;
  let sum = 0;
  let sawTurn = false;
  for (const p of phases) {
    if (typeof p.turnsUsed === 'number' && Number.isFinite(p.turnsUsed)) {
      sum += p.turnsUsed;
      sawTurn = true;
    }
  }
  return sawTurn ? sum : null;
}

// ---------------------------------------------------------------------------
// Diff-visible column selection
// ---------------------------------------------------------------------------

/**
 * Column identifiers used by the comparison table. Kept as a discriminated
 * string union so the diff-only helper can switch on them without string
 * typos. Keep in sync with the `<thead>` render in ComparisonView.
 */
export type ColumnKey =
  | 'runtime'
  | 'reasoning'
  | 'model'
  | 'status'
  | 'turns'
  | 'tokens'
  | 'cost'
  | 'duration'
  | 'writes'
  | 'costPerWrite';

/**
 * Columns that are always visible regardless of diff-only toggle state.
 * `status` is always shown because it's how operators spot failures.
 */
const ALWAYS_VISIBLE_COLUMNS: ReadonlySet<ColumnKey> = new Set<ColumnKey>(['status']);

/**
 * Read a run's value for a given column as a stable string used for
 * sameness comparison. Falls back to `'__missing__'` for null/undefined so
 * "everyone missing" still collapses (rather than looking varied because of
 * undefined !== null). Numeric columns stringify to a fixed precision so
 * floating-point jitter doesn't defeat the comparison.
 */
function readColumnValue(run: RunCompareSummary, column: ColumnKey): string {
  switch (column) {
    case 'runtime':
      return run.runtime ?? '__missing__';
    case 'reasoning':
      return run.reasoning_level ?? '__missing__';
    case 'model':
      return run.model ?? '__missing__';
    case 'status':
      return run.status;
    case 'turns': {
      const sum = sumPhaseTurns(run.usage_data);
      return sum === null ? '__missing__' : String(sum);
    }
    case 'tokens':
      return run.tokens_used === null || run.tokens_used === undefined
        ? '__missing__'
        : String(run.tokens_used);
    case 'cost':
      return run.cost_usd === null || run.cost_usd === undefined
        ? '__missing__'
        : run.cost_usd.toFixed(6);
    case 'duration':
      return run.duration_ms === null || run.duration_ms === undefined
        ? '__missing__'
        : String(run.duration_ms);
    case 'writes':
      return String(run.write_intents?.total ?? 0);
    case 'costPerWrite': {
      const v = computeCostPerWrite(run.cost_usd, run.write_intents?.total ?? 0);
      return v === null ? '__missing__' : v.toFixed(4);
    }
  }
}

/**
 * Compute which columns to show when the diff-only toggle is on. A column is
 * hidden if every run has the same stringified value for it. Columns in
 * `ALWAYS_VISIBLE_COLUMNS` are always returned regardless of uniformity.
 *
 * With 0 or 1 runs every column looks "uniform," so the caller is expected
 * to hide the toggle entirely in that case — but as a safe fallback the
 * helper still returns every candidate column when `runs.length < 2`.
 */
export function selectVisibleColumns(
  runs: RunCompareSummary[],
  candidates: ReadonlyArray<ColumnKey>,
): Set<ColumnKey> {
  if (runs.length < 2) {
    return new Set(candidates);
  }
  const visible = new Set<ColumnKey>();
  for (const column of candidates) {
    if (ALWAYS_VISIBLE_COLUMNS.has(column)) {
      visible.add(column);
      continue;
    }
    const first = readColumnValue(runs[0], column);
    let varied = false;
    for (let i = 1; i < runs.length; i++) {
      if (readColumnValue(runs[i], column) !== first) {
        varied = true;
        break;
      }
    }
    if (varied) visible.add(column);
  }
  return visible;
}

// ---------------------------------------------------------------------------
// Phase breakdown
// ---------------------------------------------------------------------------

/**
 * One row in the expandable per-run phase breakdown. Values are pre-resolved
 * against `execution_overrides.phases[name]` when present; otherwise they
 * fall back to the run-level reasoning/model. When neither is available the
 * field is `null` and the caller renders the `TASK_DEFAULT_LABEL` sentinel.
 */
export interface PhaseBreakdownRow {
  name: string;
  /**
   * Resolved reasoning for this phase: phase-level override, then run-level
   * reasoning, then null (task default).
   */
  reasoning: string | null;
  /**
   * Resolved model for this phase: phase-level override, then run-level
   * model, then null (task default).
   */
  model: string | null;
  turnsUsed: number | null;
  tokensUsed: number | null;
  costUsd: number | null;
  /** Wall-clock duration in ms parsed from `phase.usage.durationMs`. */
  durationMs: number | null;
}

/**
 * Synthetic "run" phase row used when the run has no phased breakdown. Keeps
 * the expand UX uniform — non-phased runs still get a single row that
 * mirrors the top-level cell values.
 */
const SYNTHETIC_RUN_PHASE_NAME = 'run';

/**
 * Parse `run.usage_data` and project its phases onto `PhaseBreakdownRow`s,
 * resolving phase reasoning/model against `run.execution_overrides.phases`.
 *
 * Returns a single synthetic "run" row when the run has no phases (or
 * `usage_data` is null/malformed) — consumers rely on this so the expanded
 * sub-table is always non-empty.
 */
export function buildPhaseBreakdown(
  run: RunCompareSummary,
): PhaseBreakdownRow[] {
  const phases = parseUsagePhases(run.usage_data);
  const overrides = run.execution_overrides?.phases ?? {};
  const runReasoning = run.reasoning_level ?? null;
  const runModel = run.model ?? null;

  if (phases.length === 0) {
    // Fall back to a single synthetic row mirroring the run's top-level.
    return [{
      name: SYNTHETIC_RUN_PHASE_NAME,
      reasoning: runReasoning,
      model: runModel,
      turnsUsed: sumPhaseTurns(run.usage_data),
      tokensUsed: run.tokens_used ?? null,
      costUsd: run.cost_usd ?? null,
      durationMs: run.duration_ms ?? null,
    }];
  }

  return phases.map((phase) => {
    const override = overrides[phase.name];
    return {
      name: phase.name,
      reasoning: override?.reasoningLevel ?? runReasoning,
      model: override?.model ?? runModel,
      turnsUsed:
        typeof phase.turnsUsed === 'number' && Number.isFinite(phase.turnsUsed)
          ? phase.turnsUsed
          : null,
      tokensUsed:
        typeof phase.tokensUsed === 'number' && Number.isFinite(phase.tokensUsed)
          ? phase.tokensUsed
          : null,
      costUsd:
        typeof phase.costUsd === 'number' && Number.isFinite(phase.costUsd)
          ? phase.costUsd
          : null,
      durationMs:
        typeof phase.usage?.durationMs === 'number' && Number.isFinite(phase.usage.durationMs)
          ? phase.usage.durationMs
          : null,
    };
  });
}

interface UsagePhase {
  name: string;
  turnsUsed?: number;
  tokensUsed?: number;
  costUsd?: number;
  usage?: { durationMs?: number };
}

function parseUsagePhases(usageData: string | null): UsagePhase[] {
  const parsed = tryParseJson(usageData, isObjectWithPhases);
  const phases = parsed?.phases;
  if (!Array.isArray(phases)) return [];
  // Guard against entries missing a name (malformed persistence).
  return phases.filter((p): p is UsagePhase => typeof p?.name === 'string');
}

/**
 * Count the number of phase overrides on a run. Zero when
 * `execution_overrides` is null or `phases` is absent/empty. Used by the
 * row-level "Phases: N" badge.
 */
export function countPhaseOverrides(run: Pick<RunCompareSummary, 'execution_overrides'>): number {
  const phases = run.execution_overrides?.phases;
  if (!phases) return 0;
  return Object.keys(phases).length;
}

/**
 * Format the phase-override list as a human-readable string for a tooltip.
 * Example: `prepare: high · digest: model=gpt-5`. Returns an empty string
 * when no overrides are set.
 */
export function formatPhaseOverrideTooltip(
  run: Pick<RunCompareSummary, 'execution_overrides'>,
): string {
  const phases = run.execution_overrides?.phases;
  if (!phases) return '';
  const parts: string[] = [];
  for (const [name, cfg] of Object.entries(phases)) {
    const bits: string[] = [];
    if (cfg?.reasoningLevel) bits.push(cfg.reasoningLevel);
    if (cfg?.model) bits.push(`model=${cfg.model}`);
    parts.push(`${name}: ${bits.length > 0 ? bits.join(', ') : '(no override)'}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Aggregate + drift — shared by ComparisonView
// ---------------------------------------------------------------------------

/**
 * Aggregated counters across an arbitrary run set. ComparisonView feeds a
 * client-side-derived aggregate into the StatCard row.
 */
export interface RunSetAggregate {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  totalTokens: number;
  totalCostUsd: number;
}

/**
 * Compute aggregate counters for a run set. Null/undefined tokens and cost
 * are treated as 0 contribution. Status counts use exact-match on the
 * lowercase strings the daemon emits.
 */
export function aggregateRunSet(runs: RunCompareSummary[]): RunSetAggregate {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  for (const run of runs) {
    if (run.status === 'completed') completed += 1;
    else if (run.status === 'failed') failed += 1;
    else if (run.status === 'skipped') skipped += 1;
    if (typeof run.tokens_used === 'number' && Number.isFinite(run.tokens_used)) {
      totalTokens += run.tokens_used;
    }
    if (typeof run.cost_usd === 'number' && Number.isFinite(run.cost_usd)) {
      totalCostUsd += run.cost_usd;
    }
  }
  return {
    total: runs.length,
    completed,
    failed,
    skipped,
    totalTokens,
    totalCostUsd,
  };
}

/** Threshold in minutes above which the drift banner fires. */
export const DRIFT_THRESHOLD_MINUTES = 5;

export interface DriftAnnotation {
  /** True when the banner should render. */
  show: boolean;
  /** Full integer minutes spanned by the run set's `started_at` range. */
  spanMinutes: number;
  /** True when the run set's task field is not identical across runs. */
  differentTasks: boolean;
}

/**
 * Heuristic drift detector. A run set is "drifted" when:
 *   - its `started_at` window spans more than DRIFT_THRESHOLD_MINUTES, AND
 *   - either the runs are not all the same task, OR any run started more
 *     than DRIFT_THRESHOLD_MINUTES before another
 *
 * The AND/OR coupling mirrors the plan wording: a long gap *or* a task
 * delta is enough to annotate, but a tiny gap across an identical task is
 * not worth a banner. Runs without `started_at` are ignored for the span
 * calculation but still contribute to the task-diff check.
 *
 * The banner is advisory only — the caller renders a neutral notice above
 * the table and does not block interaction.
 */
export function detectDrift(runs: RunCompareSummary[]): DriftAnnotation {
  if (runs.length < 2) {
    return { show: false, spanMinutes: 0, differentTasks: false };
  }
  let minStart: number | null = null;
  let maxStart: number | null = null;
  const tasks = new Set<string>();
  for (const run of runs) {
    if (run.task !== null && run.task !== undefined) tasks.add(run.task);
    else tasks.add('__null_task__');
    const t = run.started_at;
    if (typeof t === 'number' && Number.isFinite(t)) {
      if (minStart === null || t < minStart) minStart = t;
      if (maxStart === null || t > maxStart) maxStart = t;
    }
  }
  // `started_at` is seconds-since-epoch in this schema — convert to minutes.
  const spanSeconds =
    minStart !== null && maxStart !== null ? maxStart - minStart : 0;
  const spanMinutes = Math.floor(spanSeconds / 60);
  const differentTasks = tasks.size > 1;
  const show = spanMinutes > DRIFT_THRESHOLD_MINUTES || differentTasks;
  return { show, spanMinutes, differentTasks };
}

/**
 * Format a minutes-span as a humane duration — "12 minutes", "2 hours",
 * "3 days". Falls back to `"{N} minutes"` for edge-case inputs. Used by the
 * drift banner so the copy reads naturally for long-lived comparisons.
 */
export function formatDriftDuration(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  if (m < 60) return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(m / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

// ---------------------------------------------------------------------------
// Shared-input detection
// ---------------------------------------------------------------------------

export interface PerRunInputs {
  runId: string;
  inputs: Partial<Record<SharedInputKey, string>>;
}

export type SharedInputResult =
  | { sameInput: true; inputs: Partial<Record<SharedInputKey, string>> }
  | { sameInput: false; perRun: PerRunInputs[] }
  | { sameInput: null };

/**
 * Extract input-identifier key/value pairs from each run's rendered
 * instruction text and summarize whether the runs targeted the same input.
 *
 * Returns:
 *   - `{ sameInput: null }` when no run's instruction contained any of the
 *     recognized keys (task isn't input-parameterized).
 *   - `{ sameInput: true, inputs }` when every run's extracted key/value map
 *     is identical and non-empty — the canonical apples-to-apples case.
 *   - `{ sameInput: false, perRun }` when at least one run had inputs but
 *     the extracted maps differ (missing keys, different values, or only a
 *     subset of runs parameterized). Callers warn inline.
 */
export function detectSharedInputs(
  runs: ReadonlyArray<Pick<RunCompareSummary, 'id' | 'instruction'>>,
): SharedInputResult {
  if (runs.length === 0) return { sameInput: null };

  const perRun: PerRunInputs[] = runs.map((run) => ({
    runId: run.id,
    inputs: extractSharedInputs(run.instruction),
  }));

  const anyHasInputs = perRun.some((r) => Object.keys(r.inputs).length > 0);
  if (!anyHasInputs) return { sameInput: null };

  // A single run with inputs is trivially "same" (nothing to disagree with).
  const first = perRun[0].inputs;
  const allMatch = perRun.every((r) => inputsEqual(r.inputs, first));
  const firstHasAny = Object.keys(first).length > 0;
  if (allMatch && firstHasAny) {
    return { sameInput: true, inputs: first };
  }
  return { sameInput: false, perRun };
}

function inputsEqual(
  a: Partial<Record<SharedInputKey, string>>,
  b: Partial<Record<SharedInputKey, string>>,
): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (a[k as SharedInputKey] !== b[k as SharedInputKey]) return false;
  }
  return true;
}
