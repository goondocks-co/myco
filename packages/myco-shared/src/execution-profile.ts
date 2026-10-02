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
}

const UNSET_MODELS = { low: null, default: null, high: null };
const TIER_EFFORTS = { low: 'low', default: 'medium', high: 'high' };
const MODEL_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$';

/** Model defaults and validation vocabulary for each harness's settings. */
export const PROFILE_HARNESSES: Readonly<Record<string, HarnessProfileDefaults>> = {
  'claude-code': {
    models: { low: 'haiku', default: 'sonnet', high: 'opus' }, efforts: TIER_EFFORTS,
    allowedEfforts: ['low', 'medium', 'high', 'xhigh'],
    modelPattern: '^(haiku|sonnet|opus|fable|claude-[A-Za-z0-9][A-Za-z0-9._-]{0,240})$',
    modelHint: 'Use haiku, sonnet, opus, fable, or a claude-* model ID.',
    modelFamilies: ['haiku', 'sonnet', 'opus', 'fable'],
  },
  codex: { models: UNSET_MODELS, efforts: TIER_EFFORTS, allowedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh'], modelPattern: MODEL_ID_PATTERN, modelHint: 'Use a Codex model ID. An unset model holds runs at this tier.' },
  opencode: { models: UNSET_MODELS, efforts: TIER_EFFORTS, allowedEfforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], modelPattern: '^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._:/-]{0,240}$', modelHint: 'Use provider/model. An unset model holds runs at this tier.' },
  cursor: { models: UNSET_MODELS, efforts: TIER_EFFORTS, allowedEfforts: [], modelPattern: MODEL_ID_PATTERN, modelHint: 'Model selection is unavailable for this agent.' },
  antigravity: { models: UNSET_MODELS, efforts: TIER_EFFORTS, allowedEfforts: [], modelPattern: MODEL_ID_PATTERN, modelHint: 'Model selection is unavailable for this agent.' },
};

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

/** Alias family resolution is accepted; an explicit SKU requires the same id. */
export function profileModelMatches(harness: string, requested: string, actual: string): boolean {
  const families = PROFILE_HARNESSES[harness]?.modelFamilies ?? [];
  return requested === actual || (families.includes(requested) && actual.startsWith(`claude-${requested}-`));
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

/** The boundary each worker applies when it offers this agent. */
export const HARNESS_ASKING: Readonly<Record<string, Asking>> = {
  'claude-code': { kind: 'native' },
  codex: { kind: 'sandbox' },
  opencode: { kind: 'run-agent', env: 'OPENCODE_CONFIG_CONTENT', extensionsOff: { OPENCODE_PURE: '1' } },
  cursor: { kind: 'run-home', env: 'CURSOR_CONFIG_DIR' },
  antigravity: { kind: 'unheld' },
};

/** A worker offers only agents whose runs can be bounded. */
export const canOfferHarness = (asking: Asking): boolean => asking.kind !== 'unheld';
export const OFFERABLE_PROFILE_HARNESSES = Object.keys(HARNESS_ASKING).filter((id) => canOfferHarness(HARNESS_ASKING[id]!));
