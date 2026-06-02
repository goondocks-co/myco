/**
 * Pure helpers that seed RunTaskDialog from a previous run, powering the
 * "Rerun with same settings" feature.
 *
 * The feature launches a NEW run with the same task + instruction + dry-run
 * flag + execution overrides as an existing run. To keep the UX obvious
 * ("this is a new run, not a replacement of the source") we reuse the
 * existing RunTaskDialog as a confirmation step, pre-filled from the source.
 *
 * All shape-munging between the run's persisted `execution_overrides` (camel
 * case wire shape, nullable on every field) and the dialog's form state (the
 * UI-internal snake_case `ProviderConfig` plus `PhaseOverride` map) lives
 * here, so the dialog itself can stay small and the pre-fill logic is unit
 * testable without spinning up a React harness.
 */
import type { HarnessId, ReasoningLevel } from '@myco/agent/types';
import type { RunRow, TaskRow } from '../../hooks/use-agent';
import { REASONING_LEVELS } from '../../hooks/use-providers';
import type { ProviderConfig, PhaseOverride } from '../../hooks/use-providers';
import { extractSharedInputs, extractTemplateVars } from './shared-inputs';
import { fromWireProvider, type LooseWireProviderConfig } from './provider-coercion';

/**
 * Camel-case provider shape as persisted on `execution_overrides` — mirrors
 * the daemon wire ProviderConfig. Distinct from the UI-internal snake_case
 * `ProviderConfig` (which matches the myco.yaml on-disk shape).
 *
 * Re-exported for backwards compatibility; callers that previously imported
 * `WireProviderOverride` should migrate to `LooseWireProviderConfig` from
 * `provider-coercion.ts` (equivalent shape).
 */
export type WireProviderOverride = LooseWireProviderConfig;

/** Pre-fill payload for RunTaskDialog when rerunning an existing run. */
export interface RerunPrefill {
  taskName: string;
  taskMissing: boolean;
  instruction: string;
  dryRun: boolean;
  varValues: Record<string, string>;
  harness?: HarnessId;
  reasoningLevel?: ReasoningLevel;
  model?: string;
  provider?: ProviderConfig;
  phaseOverrides: Record<string, PhaseOverride>;
  hasAnyOverride: boolean;
}

function coerceReasoning(value: string | undefined): ReasoningLevel | undefined {
  if (!value) return undefined;
  return (REASONING_LEVELS as ReadonlyArray<string>).includes(value)
    ? (value as ReasoningLevel)
    : undefined;
}

const HARNESS_IDS: ReadonlyArray<HarnessId> = ['claude-sdk', 'openai-agents'];

function coerceHarness(value: string | undefined): HarnessId | undefined {
  if (!value) return undefined;
  return (HARNESS_IDS as ReadonlyArray<string>).includes(value)
    ? (value as HarnessId)
    : undefined;
}

/**
 * Build the pre-fill payload for RunTaskDialog from a source run. Callers
 * should pass the current list of tasks (from useAgentTasks) so we can flag
 * the deleted-task edge case without blocking the dialog — the user sees
 * "task definition not found" in the title and can still submit, letting the
 * daemon reject at the wire layer if the task is truly gone.
 */
export function buildRerunPrefill(
  sourceRun: RunRow,
  tasks: ReadonlyArray<TaskRow>,
): RerunPrefill {
  const taskName = sourceRun.task ?? '';
  const matchingTask = tasks.find((t) => t.name === taskName);
  const taskMissing = taskName !== '' && matchingTask === undefined;

  const instruction = sourceRun.instruction ?? '';

  const rawVars = extractSharedInputs(instruction);
  const varValues: Record<string, string> = {};
  if (matchingTask) {
    const templateVarNames = new Set(
      extractTemplateVars(matchingTask.prompt, { includeAutoResolved: true }),
    );
    for (const [key, value] of Object.entries(rawVars)) {
      if (templateVarNames.has(key)) varValues[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(rawVars)) {
      varValues[key] = value;
    }
  }

  const overrides = sourceRun.execution_overrides ?? null;

  const harness = coerceHarness(overrides?.harness);
  const reasoningLevel = coerceReasoning(overrides?.reasoningLevel);
  const model = overrides?.model || undefined;
  const provider = fromWireProvider(overrides?.provider);

  const phaseOverrides: Record<string, PhaseOverride> = {};
  if (overrides?.phases) {
    for (const [phaseName, entry] of Object.entries(overrides.phases)) {
      const phaseProvider = fromWireProvider(entry.provider);
      const phaseModel = entry.model && entry.model.length > 0 ? entry.model : undefined;
      const phaseMaxTurns = typeof entry.maxTurns === 'number' ? entry.maxTurns : undefined;
      // Tier override added in the cost-tuning work; same coercion as the
      // top-level reasoningLevel above. Missing this dropped the user's
      // explicit tier choice on every rerun.
      const phaseReasoning = coerceReasoning(entry.reasoningLevel);
      if (
        phaseProvider !== undefined
        || phaseModel !== undefined
        || phaseMaxTurns !== undefined
        || phaseReasoning !== undefined
      ) {
        const po: PhaseOverride = {};
        if (phaseProvider) po.provider = phaseProvider;
        if (phaseReasoning) po.reasoningLevel = phaseReasoning;
        if (phaseModel) po.model = phaseModel;
        if (phaseMaxTurns !== undefined) po.maxTurns = phaseMaxTurns;
        phaseOverrides[phaseName] = po;
      }
    }
  }

  const hasAnyOverride =
    harness !== undefined
    || reasoningLevel !== undefined
    || model !== undefined
    || provider !== undefined
    || Object.keys(phaseOverrides).length > 0;

  return {
    taskName,
    taskMissing,
    instruction,
    dryRun: sourceRun.dry_run === true,
    varValues,
    harness,
    reasoningLevel,
    model,
    provider,
    phaseOverrides,
    hasAnyOverride,
  };
}
