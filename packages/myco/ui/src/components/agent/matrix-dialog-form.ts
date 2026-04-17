/**
 * Pure helpers for `MatrixRunDialog` — the matrix creation path that POSTs
 * to /api/agent/evaluations. (Previously lived alongside RunTaskDialog as
 * `evaluation-matrix-form.ts`; moved to its own dialog as part of the
 * Comparisons-primary pivot.)
 *
 * The matrix dialog collects per-dimension arrays (runtimes, reasoning
 * levels, models) plus the same per-phase overrides and dry-run flag used
 * in single-run mode. These helpers:
 *   - compute the live cell count for the summary bar
 *   - build the `matrix` payload the daemon expects (`POST /agent/evaluations`)
 *
 * Extracted for the same reason as `execution-overrides.ts`: the React
 * dialog has no testing-library harness; unit-testing the pure shape
 * transformations is the coverage bar.
 */

import type { RuntimeId, ReasoningLevel } from '@myco/agent/types';
import type { ProviderConfig } from '../../hooks/use-providers';
import {
  toWireProvider,
  type PhaseOverrideFormEntry,
  type WireProviderConfig,
} from './execution-overrides';

/** Per-phase wire shape that POST /agent/evaluations accepts under
 *  `matrix.phases` — identical to the per-phase shape on /agent/run. */
export interface WirePhaseOverride {
  reasoningLevel?: ReasoningLevel;
  model?: string;
  provider?: WireProviderConfig;
  maxTurns?: number;
}

/** The full `matrix` body posted to `/api/agent/evaluations`. */
export interface MatrixPayload {
  runtimes?: RuntimeId[];
  reasoningLevels?: ReasoningLevel[];
  models?: string[];
  dryRun?: boolean;
  notes?: string;
  phases?: Record<string, WirePhaseOverride>;
}

/** Form state captured by the dialog's Compare mode. */
export interface MatrixFormState {
  runtimes: RuntimeId[];
  reasoningLevels: ReasoningLevel[];
  models: string[];
  dryRun: boolean;
  notes?: string;
  /** Per-phase overrides shared across every cell. Same shape as single-run
   *  mode so the existing PhaseConfigRow UI slots in unchanged. */
  phases: Record<string, PhaseOverrideFormEntry>;
}

/**
 * Compute the number of cells the matrix will produce. Empty dimensions
 * collapse to a factor of 1 (task default for that axis). An empty matrix
 * therefore produces a single "all defaults" cell.
 */
export function computeCellCount(form: {
  runtimes: unknown[];
  reasoningLevels: unknown[];
  models: unknown[];
}): number {
  const r = form.runtimes.length === 0 ? 1 : form.runtimes.length;
  const l = form.reasoningLevels.length === 0 ? 1 : form.reasoningLevels.length;
  const m = form.models.length === 0 ? 1 : form.models.length;
  return r * l * m;
}

/**
 * Convert per-phase form entries into the wire-shape matrix.phases record.
 * Empty entries (no reasoning, model, provider, or maxTurns set) are
 * dropped so a half-filled row doesn't produce a phantom `{}` on the wire.
 */
export function mapPhasesToWire(
  phases: Record<string, PhaseOverrideFormEntry>,
): Record<string, WirePhaseOverride> | undefined {
  const out: Record<string, WirePhaseOverride> = {};
  for (const [name, entry] of Object.entries(phases)) {
    const phasePayload: WirePhaseOverride = {};
    if (entry.reasoningLevel) phasePayload.reasoningLevel = entry.reasoningLevel;
    const model = entry.model?.trim();
    if (model) phasePayload.model = model;
    if (entry.provider) {
      const wire = toWireProvider(entry.provider as ProviderConfig);
      if (wire) phasePayload.provider = wire;
    }
    if (entry.maxTurns !== undefined) phasePayload.maxTurns = entry.maxTurns;

    if (
      phasePayload.reasoningLevel !== undefined
      || phasePayload.model !== undefined
      || phasePayload.provider !== undefined
      || phasePayload.maxTurns !== undefined
    ) {
      out[name] = phasePayload;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the `matrix` body the daemon expects. Only includes keys that are
 * actually present: empty arrays collapse to "task default for that axis"
 * and are omitted, phases are omitted when no per-phase entry has any
 * overrides, dryRun is only set when true.
 */
export function buildMatrixPayload(form: MatrixFormState): MatrixPayload {
  const out: MatrixPayload = {};
  if (form.runtimes.length > 0) out.runtimes = [...form.runtimes];
  if (form.reasoningLevels.length > 0) out.reasoningLevels = [...form.reasoningLevels];
  if (form.models.length > 0) {
    // Trim + drop empty entries so a stray trailing comma in the textarea
    // UX doesn't become an empty-string model cell.
    const cleaned = form.models.map((m) => m.trim()).filter((m) => m.length > 0);
    if (cleaned.length > 0) out.models = cleaned;
  }
  if (form.dryRun) out.dryRun = true;
  const notes = form.notes?.trim();
  if (notes) out.notes = notes;
  const phases = mapPhasesToWire(form.phases);
  if (phases) out.phases = phases;
  return out;
}
