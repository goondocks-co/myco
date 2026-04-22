/**
 * Pure helpers for RunTaskDialog's "Run configuration" editor.
 *
 * The dialog lets an operator override runtime, provider, model, reasoning,
 * and per-phase config for a single run without touching the task YAML. The
 * form UI is a thin wrapper around `buildExecutionOverrides`, which compares
 * the form state against the task's effective defaults and returns either
 * (a) a payload with only the fields that actually differ, or (b) `undefined`
 * when nothing differs — so the client doesn't send a no-op
 * `executionOverrides: {}` that the backend would otherwise persist.
 *
 * Extracted to a standalone module so it can be unit-tested without a React
 * harness (same rationale as `comparison-helpers.ts`).
 */

import type { RuntimeId, ReasoningLevel } from '@myco/agent/types';
import type { ProviderConfig } from '../../hooks/use-providers';
import { toWireProvider, type WireProviderConfig } from './provider-coercion';

export { toWireProvider, type WireProviderConfig };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-phase form entry — matches the wire payload shape. */
export interface PhaseOverrideFormEntry {
  reasoningLevel?: ReasoningLevel;
  model?: string;
  /** Full provider override for this phase (wire-shape, snake_case). */
  provider?: ProviderConfig;
  maxTurns?: number;
}

/** The raw form state held inside RunTaskDialog. All fields optional; an
 *  `undefined` value means "use the task default" (i.e. no override). */
export interface OverridesFormState {
  runtime?: RuntimeId;
  reasoningLevel?: ReasoningLevel;
  model?: string;
  /** Full top-level provider override. */
  provider?: ProviderConfig;
  /** Keyed by phase name. Empty object = no per-phase overrides. */
  phases: Record<string, PhaseOverrideFormEntry>;
}

/** Effective defaults resolved from the task YAML + global config, mirrored
 *  from the backend via `useTaskConfig` + `resolveReasoningModel`. */
export interface EffectiveDefaults {
  runtime: RuntimeId;
  reasoningLevel?: ReasoningLevel;
  model?: string;
  /** Task-level resolved provider (so we can tell if the form's provider differs). */
  provider?: ProviderConfig;
  phases?: Array<{
    name: string;
    reasoningLevel?: ReasoningLevel;
    model?: string;
    provider?: ProviderConfig;
    maxTurns?: number;
  }>;
}

/** Wire-shape posted to `/agent/run` under `executionOverrides`. Matches
 *  `RunOptions.executionOverrides` in `@myco/agent/types` (camelCase). */
export interface ExecutionOverridesPayload {
  runtime?: RuntimeId;
  reasoningLevel?: ReasoningLevel;
  model?: string;
  provider?: WireProviderConfig;
  phases?: Record<string, {
    reasoningLevel?: ReasoningLevel;
    model?: string;
    provider?: WireProviderConfig;
    maxTurns?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Structural equality for ProviderConfig (snake_case wire shape). Ignores key
 * ordering by serializing both sides with sorted keys.
 */
function providersEqual(
  a: ProviderConfig | undefined,
  b: ProviderConfig | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/**
 * Return the overrides payload to send, or `undefined` when every field in
 * `form` matches the corresponding default in `defaults`. Empty-string and
 * default-equal values are stripped so an operator can "reset" a field by
 * selecting the task default and get `undefined` on the wire.
 */
export function buildExecutionOverrides(
  form: OverridesFormState,
  defaults: EffectiveDefaults,
): ExecutionOverridesPayload | undefined {
  const payload: ExecutionOverridesPayload = {};

  // Top-level runtime: only included when set AND different from default.
  if (form.runtime && form.runtime !== defaults.runtime) {
    payload.runtime = form.runtime;
  }

  // Top-level reasoning: include when set AND different from default.
  if (form.reasoningLevel && form.reasoningLevel !== defaults.reasoningLevel) {
    payload.reasoningLevel = form.reasoningLevel;
  }

  // Top-level model: trim, drop empty, compare against default.
  const modelValue = normalizeString(form.model);
  if (modelValue && modelValue !== defaults.model) {
    payload.model = modelValue;
  }

  // Top-level provider: include when structurally different from the default.
  if (form.provider && !providersEqual(form.provider, defaults.provider)) {
    payload.provider = toWireProvider(form.provider);
  }

  // Per-phase overrides.
  const defaultsByPhase = new Map<string, {
    reasoningLevel?: ReasoningLevel;
    model?: string;
    provider?: ProviderConfig;
    maxTurns?: number;
  }>();
  for (const phase of defaults.phases ?? []) {
    defaultsByPhase.set(phase.name, {
      reasoningLevel: phase.reasoningLevel,
      model: phase.model,
      provider: phase.provider,
      maxTurns: phase.maxTurns,
    });
  }

  const phaseOverrides: Record<string, {
    reasoningLevel?: ReasoningLevel;
    model?: string;
    provider?: WireProviderConfig;
    maxTurns?: number;
  }> = {};
  for (const [name, entry] of Object.entries(form.phases)) {
    const phaseDefault = defaultsByPhase.get(name) ?? {};
    const phasePayload: {
      reasoningLevel?: ReasoningLevel;
      model?: string;
      provider?: WireProviderConfig;
      maxTurns?: number;
    } = {};

    if (entry.reasoningLevel && entry.reasoningLevel !== phaseDefault.reasoningLevel) {
      phasePayload.reasoningLevel = entry.reasoningLevel;
    }
    const phaseModel = normalizeString(entry.model);
    if (phaseModel && phaseModel !== phaseDefault.model) {
      phasePayload.model = phaseModel;
    }
    if (entry.provider && !providersEqual(entry.provider, phaseDefault.provider)) {
      phasePayload.provider = toWireProvider(entry.provider);
    }
    if (entry.maxTurns !== undefined && entry.maxTurns !== phaseDefault.maxTurns) {
      phasePayload.maxTurns = entry.maxTurns;
    }

    if (
      phasePayload.reasoningLevel !== undefined
      || phasePayload.model !== undefined
      || phasePayload.provider !== undefined
      || phasePayload.maxTurns !== undefined
    ) {
      phaseOverrides[name] = phasePayload;
    }
  }

  if (Object.keys(phaseOverrides).length > 0) {
    payload.phases = phaseOverrides;
  }

  // Nothing differed → don't emit an override at all.
  if (
    payload.runtime === undefined
    && payload.reasoningLevel === undefined
    && payload.model === undefined
    && payload.provider === undefined
    && payload.phases === undefined
  ) {
    return undefined;
  }

  return payload;
}

/**
 * Count how many distinct overrides are currently active in `form` relative
 * to `defaults`. Used to render the "(N)" badge next to the collapsible
 * section header.
 */
export function countOverrides(
  form: OverridesFormState,
  defaults: EffectiveDefaults,
): number {
  const payload = buildExecutionOverrides(form, defaults);
  if (!payload) return 0;
  let count = 0;
  if (payload.runtime !== undefined) count++;
  if (payload.reasoningLevel !== undefined) count++;
  if (payload.model !== undefined) count++;
  if (payload.provider !== undefined) count++;
  if (payload.phases) {
    for (const entry of Object.values(payload.phases)) {
      if (entry.reasoningLevel !== undefined) count++;
      if (entry.model !== undefined) count++;
      if (entry.provider !== undefined) count++;
      if (entry.maxTurns !== undefined) count++;
    }
  }
  return count;
}
