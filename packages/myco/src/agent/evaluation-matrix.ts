/**
 * Shared matrix cell enumeration for agent evaluations.
 *
 * An evaluation fans a single task out across a cartesian product of
 * (runtime × reasoningLevel × model) cells. The daemon creates runs in
 * deterministic iteration order so downstream consumers can zip cells
 * against run rows reliably — which means the one canonical iteration
 * order must live in one place.
 *
 * NOTE: This module is currently only imported from backend (daemon API +
 * CLI). The frontend (evaluation-helpers.ts) will switch to reading the
 * per-run `reasoning_level` / `execution_overrides` columns directly and
 * can drop its local copy in a separate commit.
 */

import type { ReasoningLevel, RuntimeId } from './types.js';

export interface EvaluationMatrixCell {
  runtime?: RuntimeId;
  reasoningLevel?: ReasoningLevel;
  model?: string;
}

export interface EvaluationMatrixDimensions {
  runtimes?: RuntimeId[];
  reasoningLevels?: ReasoningLevel[];
  models?: string[];
}

/**
 * Enumerate the cartesian product of the matrix dimensions. Any missing
 * dimension is treated as a single-cell axis holding `undefined` (so the
 * run falls back to the task's default for that field). Iteration order is
 * runtimes × reasoningLevels × models — this is load-bearing: the daemon
 * creates runs in this order and the CLI / UI zip cells by started_at ASC.
 *
 * Undefined fields are omitted from the cell object (not set to
 * `undefined`) so `'field' in cell` works as an existence check.
 */
export function enumerateMatrixCells(
  matrix: EvaluationMatrixDimensions,
): EvaluationMatrixCell[] {
  const runtimes: Array<RuntimeId | undefined> =
    matrix.runtimes && matrix.runtimes.length > 0 ? matrix.runtimes : [undefined];
  const reasoningLevels: Array<ReasoningLevel | undefined> =
    matrix.reasoningLevels && matrix.reasoningLevels.length > 0
      ? matrix.reasoningLevels
      : [undefined];
  const models: Array<string | undefined> =
    matrix.models && matrix.models.length > 0 ? matrix.models : [undefined];

  const cells: EvaluationMatrixCell[] = [];
  for (const runtime of runtimes) {
    for (const reasoningLevel of reasoningLevels) {
      for (const model of models) {
        cells.push({
          ...(runtime !== undefined ? { runtime } : {}),
          ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
          ...(model !== undefined ? { model } : {}),
        });
      }
    }
  }
  return cells;
}
