/**
 * Phase-level execution resolution — extracted so both `executor.ts` (for
 * re-export / direct tests) and `phase-loop.ts` (for the actual loop) can
 * depend on it without introducing a circular import.
 *
 * `resolvePhaseExecution` reconciles all sources that can contribute to a
 * single phase's `{ reasoningLevel, model, provider, maxTurns }`:
 *
 *   - RunOptions.executionOverrides (top-level + per-phase)
 *   - phase.* (task YAML)
 *   - myco.yaml per-phase overrides (keyed by phase name)
 *   - task-level provider override (resolved from myco.yaml)
 *   - EffectiveConfig (task / agent defaults)
 */

import { resolveReasoningModel } from './reasoning-levels.js';
import type {
  EffectiveConfig,
  PhaseDefinition,
  ProviderConfig,
  ReasoningLevel,
  RunOptions,
} from './types.js';

/**
 * myco.yaml-sourced per-phase provider / model / maxTurns overrides, keyed
 * by phase name. Passed through `resolveRunConfig` alongside the
 * task-level provider override.
 */
export interface MycoYamlPhaseOverrides {
  [phaseName: string]: {
    provider?: ProviderConfig;
    model?: string;
    maxTurns?: number;
  };
}

/**
 * Walk an ordered list of lookups and return the first defined value. Keeps
 * precedence chains declarative so unit tests can exercise each source
 * individually without re-running the entire resolver.
 */
function firstDefined<T>(lookups: Array<() => T | undefined>): T | undefined {
  for (const lookup of lookups) {
    const value = lookup();
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Compute the effective `{ reasoningLevel, model, provider, maxTurns }` for
 * a single phase by reconciling all layered sources. Extracted for
 * unit-testability — the wave loop calls this helper directly.
 *
 * Provider precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].provider` — run override
 *   2. `phase.provider` — task YAML
 *   3. `phaseProviderOverrides[name].provider` — myco.yaml per-phase override
 *   4. `options.executionOverrides.provider` — top-level run override
 *   5. `provider` parameter — task default / task override from myco.yaml
 *
 * Model precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].model`
 *   2. `phaseProviderOverrides[name].model` (myco.yaml)
 *   3. `resolveReasoningModel(effectiveReasoning, provider, fallback)`
 *      where `fallback = phase.model ?? options.executionOverrides.model
 *      ?? config.model`
 *
 * Reasoning precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].reasoningLevel`
 *   2. `phase.reasoningLevel` (task YAML)
 *   3. `options.executionOverrides.reasoningLevel`
 *   4. `config.execution.reasoningLevel`
 *   5. `config.reasoningLevel`
 *
 * maxTurns precedence (highest → lowest):
 *   1. `options.executionOverrides.phases[name].maxTurns`
 *   2. `phaseProviderOverrides[name].maxTurns` (myco.yaml)
 *   3. `phase.maxTurns` (task YAML)
 */
export function resolvePhaseExecution(
  phase: PhaseDefinition,
  options: RunOptions | undefined,
  config: EffectiveConfig,
  provider: ProviderConfig | undefined,
  phaseProviderOverrides?: MycoYamlPhaseOverrides,
): { reasoningLevel: ReasoningLevel | undefined; model: string; maxTurns: number; provider: ProviderConfig | undefined } {
  const runPhaseOverride = options?.executionOverrides?.phases?.[phase.name];
  const topOverride = options?.executionOverrides;
  const mycoYamlPhase = phaseProviderOverrides?.[phase.name];

  const effectiveProvider = firstDefined<ProviderConfig>([
    () => runPhaseOverride?.provider,
    () => phase.provider,
    () => mycoYamlPhase?.provider,
    () => topOverride?.provider,
    () => provider,
  ]);

  const effectiveReasoning = firstDefined<ReasoningLevel>([
    () => runPhaseOverride?.reasoningLevel,
    () => phase.reasoningLevel,
    () => topOverride?.reasoningLevel,
    () => config.execution?.reasoningLevel,
    () => config.reasoningLevel,
  ]);

  const fallbackModel = firstDefined<string>([
    () => phase.model,
    () => topOverride?.model,
    () => config.model,
  ]);

  const effectiveModel = firstDefined<string>([
    () => runPhaseOverride?.model,
    () => mycoYamlPhase?.model,
    () => resolveReasoningModel(effectiveReasoning, effectiveProvider, fallbackModel ?? ''),
  ]) ?? '';

  const effectiveMaxTurns = runPhaseOverride?.maxTurns
    ?? mycoYamlPhase?.maxTurns
    ?? phase.maxTurns;

  return {
    reasoningLevel: effectiveReasoning,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    provider: effectiveProvider,
  };
}

/**
 * Warn once per run when `executionOverrides.phases` contains keys that do
 * not match any phase in the task. The warning lists the unknown keys and
 * the task's actual phase names so callers can correct their payload.
 */
export function warnUnknownPhaseOverrides(
  options: RunOptions | undefined,
  taskPhases: readonly PhaseDefinition[] | undefined,
): void {
  const overridePhases = options?.executionOverrides?.phases;
  if (!overridePhases) return;
  const keys = Object.keys(overridePhases);
  if (keys.length === 0) return;
  const known = new Set((taskPhases ?? []).map((p) => p.name));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  const taskPhaseNames = (taskPhases ?? []).map((p) => p.name);
  console.warn(
    `[agent] Unknown phase override keys: ${unknown.join(', ')} ` +
    `(task phases: ${taskPhaseNames.join(', ') || '<none>'})`,
  );
}
