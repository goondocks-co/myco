import { RUNNER_HARNESSES } from './runner-harnesses.generated.js';

/** The server resolves and records every claimed run's execution profile. */
export const EXECUTION_PROFILE_FEATURE = 'execution-profile';

export const REASONING_TIERS = ['low', 'default', 'high'] as const;
export type ReasoningTier = typeof REASONING_TIERS[number];
export const MODEL_MISMATCH = 'model_mismatch';

export interface ExecutionProfile {
  tier: ReasoningTier;
  model: string;
  effort: string | null;
  sources: { tier: 'task' | 'task-override'; model: 'default' | 'configured' | 'task-pin' };
}

export interface ProfileCapability {
  model: 'flag' | 'config' | 'none';
  efforts: readonly string[];
}

interface HarnessProfileDefaults {
  models: Readonly<Record<ReasoningTier, string | null>>;
  efforts: Readonly<Record<ReasoningTier, string>>;
  allowedEfforts: readonly string[];
  modelPattern: string;
  modelHint: string;
  modelFamilies?: readonly string[];
  /** How a dated id of a family begins: an alias `sonnet` resolves to `<prefix>sonnet-…`. */
  modelFamilyPrefix?: string;
}

/** Model defaults and validation vocabulary for each harness's settings, from its manifest's `runner.profile`, in the order a worker ranks them. */
export const PROFILE_HARNESSES: Readonly<Record<string, HarnessProfileDefaults>> = Object.fromEntries(
  RUNNER_HARNESSES.map((harness) => [harness.id, harness.profile as HarnessProfileDefaults]),
);

export const CONFIGURABLE_PROFILE_HARNESSES = Object.keys(PROFILE_HARNESSES).filter((id) => PROFILE_HARNESSES[id]!.allowedEfforts.length > 0);

export const isReasoningTier = (value: unknown): value is ReasoningTier => REASONING_TIERS.some((tier) => tier === value);

export function modelRefusal(harness: string, value: unknown): string | null {
  const spec = PROFILE_HARNESSES[harness];
  if (spec === undefined) return 'unknown agent';
  return typeof value === 'string' && new RegExp(spec.modelPattern).test(value) ? null : `expected a model id for ${harness}`;
}

export function effortRefusal(harness: string, value: unknown): string | null {
  const spec = PROFILE_HARNESSES[harness];
  return spec !== undefined && typeof value === 'string' && spec.allowedEfforts.includes(value) ? null : `expected a supported effort for ${harness}`;
}

/** A capability absent from an older offer cannot apply a profile. */
export function profileSupported(profile: ExecutionProfile, capability: ProfileCapability | undefined): boolean {
  return isExecutionProfile(profile) && capability !== undefined && capability !== null
    && (capability.model === 'flag' || capability.model === 'config')
    && Array.isArray(capability.efforts) && capability.efforts.every((effort) => typeof effort === 'string' && effort.trim().length > 0)
    && (profile.effort === null || capability.efforts.includes(profile.effort));
}

export function isExecutionProfile(value: unknown): value is ExecutionProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const sources = p.sources;
  if (!isReasoningTier(p.tier) || typeof p.model !== 'string' || p.model.trim() === '' || !(p.effort === null || typeof p.effort === 'string')
    || sources === null || typeof sources !== 'object' || Array.isArray(sources)) return false;
  const s = sources as Record<string, unknown>;
  return (s.tier === 'task' || s.tier === 'task-override') && (s.model === 'default' || s.model === 'configured' || s.model === 'task-pin');
}

/** Read only the public requested profile from a run's private overrides. */
export function requestedProfile(raw: unknown): ExecutionProfile | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate: unknown = (parsed as Record<string, unknown>).requested;
  if (!isExecutionProfile(candidate)) return null;
  return { tier: candidate.tier, model: candidate.model, effort: candidate.effort, sources: { tier: candidate.sources.tier, model: candidate.sources.model } };
}

/**
 * Whether the model a run reported is the one it was asked for. An explicit id matches the same id, or the same id
 * under the provider the run reported where the requested one names it (`openai/gpt-5.5` is `gpt-5.5` from `openai`);
 * an alias matches a dated id of its family.
 */
export function profileModelMatches(harness: string, requested: string, actual: { model: string; provider?: string }): boolean {
  const spec = PROFILE_HARNESSES[harness];
  const families = spec?.modelFamilies ?? [];
  return requested === actual.model
    || (actual.provider !== undefined && requested === `${actual.provider}/${actual.model}`)
    || (families.includes(requested) && actual.model.startsWith(`${spec?.modelFamilyPrefix ?? ''}${requested}-`));
}

/**
 * How a harness comes to ask before a call, or what bounds a run on a harness
 * that never asks.
 *
 * - `native`: a native driver pins the run's grant as the harness's own
 *   permissions, and the harness refuses whatever it does not allow.
 * - `sandbox`: the harness asks nothing and the run's grant does not apply. Its
 *   driver pins an operating-system sandbox that is the run's whole bound: what
 *   its commands may read, write and reach.
 * - `run-agent`: the harness asks only where its configuration says to, so a
 *   run starts in an agent of its own, supplied as configuration content in the
 *   variable `env`, under which every call asks; the session must report that
 *   agent as its mode. `extensionsOff` is the environment that keeps the
 *   extensions the machine installed out of the run's harness process, since an
 *   extension can answer a permission request itself.
 * - `run-home`: the harness asks for any call its configuration has not
 *   approved in advance, so a run reads a configuration directory of its own,
 *   named in the variable `env`, in which nothing is approved in advance.
 * - `unheld`: the harness approves in advance whatever its user's configuration
 *   approves, and a run cannot be given a configuration of its own, so no call
 *   it approved that way would reach the run's grant. No worker offers it.
 */
export type Asking =
  | { kind: 'native' }
  | { kind: 'sandbox' }
  | { kind: 'run-agent'; env: string; extensionsOff: Readonly<Record<string, string>> }
  | { kind: 'run-home'; env: string }
  | { kind: 'unheld' };

/** The boundary each worker applies when it offers this agent, from its manifest's `runner.asking`. */
export const HARNESS_ASKING: Readonly<Record<string, Asking>> = Object.fromEntries(
  RUNNER_HARNESSES.map((harness) => [harness.id, harness.asking as Asking]),
);

/** A worker offers only agents whose runs can be bounded. */
export const canOfferHarness = (asking: Asking): boolean => asking.kind !== 'unheld';
export const OFFERABLE_PROFILE_HARNESSES = Object.keys(HARNESS_ASKING).filter((id) => canOfferHarness(HARNESS_ASKING[id]!));
