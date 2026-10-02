import { RUNNER_HARNESSES } from './runner-harnesses.generated.js';

/** The server resolves and records every claimed run's execution profile. */
export const EXECUTION_PROFILE_FEATURE = 'execution-profile';

export const REASONING_TIERS = ['low', 'default', 'high'] as const;
export type ReasoningTier = typeof REASONING_TIERS[number];
export const MODEL_MISMATCH = 'model_mismatch';
/** A run asked for a model its provider resolves at each request, that reported another, with no resolution to judge it by. */
export const MODEL_UNCONFIRMED = 'model_unconfirmed';
/** A run whose agent offered no effort setting for its model, so the claimed effort was not applied. */
export const EFFORT_UNAPPLIED = 'effort_unapplied';
/** Warnings about how a run's claimed profile was applied, which say nothing about its accounting. */
export const PROFILE_WARNINGS: readonly string[] = [MODEL_MISMATCH, MODEL_UNCONFIRMED, EFFORT_UNAPPLIED];

/** The code a worker ends a run with when its agent cannot run the claimed model or effort. */
export const PROFILE_UNAPPLIED = 'profile_unapplied';

/**
 * The Deployment reads a worker's profile refusal (`refusal` on its end report) and the warnings `PROFILE_WARNINGS`
 * names as saying nothing about a run's accounting. A worker sends either only where the Deployment advertises this.
 */
export const PROFILE_OUTCOME_FEATURE = 'profile-outcome-v1';

/** The longest refusal reason a Deployment keeps. */
export const MAX_REFUSAL_REASON_CHARS = 500;

/**
 * A run a worker ended on its agent's refusal of the claimed profile, with the words the run's page shows
 * after "The agent couldn't use the chosen model:", or null where the worker had none to give.
 */
export interface ProfileRefusal { code: typeof PROFILE_UNAPPLIED; reason: string | null }

/** A worker's profile refusal as its end report carries it, or null for anything else. */
export function parseProfileRefusal(value: unknown): ProfileRefusal | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { code?: unknown; reason?: unknown };
  if (raw.code !== PROFILE_UNAPPLIED) return null;
  const reason = typeof raw.reason === 'string' && raw.reason.trim() !== '' ? raw.reason.trim().slice(0, MAX_REFUSAL_REASON_CHARS) : null;
  return { code: PROFILE_UNAPPLIED, reason };
}

export interface ExecutionProfile {
  tier: ReasoningTier;
  model: string;
  effort: string | null;
  sources: { tier: 'task' | 'task-override'; model: 'default' | 'configured' | 'task-pin' };
  /** The model the claiming worker's harness listed `model` as resolving to, where it listed a different one. */
  resolvesTo?: string;
}

export interface ProfileCapability {
  model: 'flag' | 'config' | 'none';
  efforts: readonly string[];
}

/** A model for each tier, offered as one choice where a worker lists every one of them for the harness. */
export interface ModelPreset {
  id: string;
  /** The provider whose login the models need, as the harness names it. */
  provider: string;
  label: string;
  /** What the preset sets, in plain words. */
  description: string;
  models: Readonly<Record<ReasoningTier, string>>;
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
  /** What a model id its provider resolves to a model of its own choosing at each request matches, as a regular expression. */
  providerAliasPattern?: string;
  presets?: readonly ModelPreset[];
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
  return (s.tier === 'task' || s.tier === 'task-override') && (s.model === 'default' || s.model === 'configured' || s.model === 'task-pin')
    && (p.resolvesTo === undefined || (typeof p.resolvesTo === 'string' && p.resolvesTo.trim() !== ''));
}

/** Read only the public requested profile from a run's private overrides. */
export function requestedProfile(raw: unknown): ExecutionProfile | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const candidate: unknown = (parsed as Record<string, unknown>).requested;
  if (!isExecutionProfile(candidate)) return null;
  return {
    tier: candidate.tier, model: candidate.model, effort: candidate.effort, sources: { tier: candidate.sources.tier, model: candidate.sources.model },
    ...(candidate.resolvesTo === undefined ? {} : { resolvesTo: candidate.resolvesTo }),
  };
}

/**
 * Whether the model a run reported is the one it was asked for, on what the harness reported and nothing else.
 *
 * A model id matches the same id, or the same id under the provider the run reported where the requested one names
 * it (`openai/gpt-5.5` is `gpt-5.5` from `openai`, and `openrouter/~anthropic/claude-opus-latest` is
 * `~anthropic/claude-opus-latest` from `openrouter`). Where the claiming worker's harness listed what the requested
 * model resolves to (`resolvesTo`), the model it resolves to matches too. An alias the manifest declares as a family
 * (`modelFamilies`) also matches a dated id of that family. Nothing else matches: an alias whose resolution the
 * harness never reported does not match a model whose name merely resembles it.
 */
export function profileModelMatches(
  harness: string, requested: Pick<ExecutionProfile, 'model' | 'resolvesTo'>, actual: { model: string; provider?: string },
): boolean {
  const same = (id: string): boolean => id === actual.model || (actual.provider !== undefined && id === `${actual.provider}/${actual.model}`);
  const spec = PROFILE_HARNESSES[harness];
  return same(requested.model)
    || (requested.resolvesTo !== undefined && same(requested.resolvesTo))
    || ((spec?.modelFamilies ?? []).includes(requested.model) && actual.model.startsWith(`${spec?.modelFamilyPrefix ?? ''}${requested.model}-`));
}

/** How a run's model compares with the request: the same, another, or another that nothing reported can judge. */
export type ModelVerdict = 'match' | 'mismatch' | 'unconfirmed';

/**
 * Whether a run ran the model it asked for (`profileModelMatches`), and where it did not, whether that is known. A
 * model the manifest says its provider resolves at each request (`providerAliasPattern`), with no resolution the
 * harness listed, reported as another model is unconfirmed: the provider may have served exactly what the alias
 * names, and nothing the run or the harness reported says either way.
 */
export function profileModelVerdict(
  harness: string, requested: Pick<ExecutionProfile, 'model' | 'resolvesTo'>, actual: { model: string; provider?: string },
): ModelVerdict {
  if (profileModelMatches(harness, requested, actual)) return 'match';
  const aliases = PROFILE_HARNESSES[harness]?.providerAliasPattern;
  return requested.resolvesTo === undefined && aliases !== undefined && new RegExp(aliases).test(requested.model) ? 'unconfirmed' : 'mismatch';
}

/**
 * The Deployment stores the models each worker lists for the harnesses it offers (`POST /worker/models`) and answers
 * them to Settings. A worker lists and sends them only where the Deployment advertises this.
 */
export const MODEL_CATALOG_FEATURE = 'model-catalog-v1';

/** How long a worker's list of a harness's models stands before the worker lists them again. */
export const MODEL_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
/**
 * How long a stored list counts as what a machine can run: two listings' worth, so one missed listing keeps a
 * machine's models offered and a machine that stopped listing drops out by the second.
 */
export const MODEL_CATALOG_FRESH_MS = 2 * MODEL_CATALOG_REFRESH_MS;

/** The most models a catalog keeps; a harness listing more is cut to this and marked `truncated`. */
export const MAX_CATALOG_MODELS = 1000;
/** The most a catalog's models take as JSON, so one catalog always fits one report; past it the rest are cut and the catalog marked `truncated`. */
export const MAX_CATALOG_MODEL_BYTES = 192 * 1024;
/** The most catalogs one report carries: one per harness. */
export const MAX_CATALOG_HARNESSES = 16;
const MAX_CATALOG_ID_CHARS = 256;
const MAX_CATALOG_LABEL_CHARS = 128;
const MAX_CATALOG_EFFORTS = 16;
const MAX_CATALOG_EFFORT_CHARS = 64;
const MAX_CATALOG_SOURCE_CHARS = 256;

/** One model a harness listed, as the worker read it. */
export interface CatalogModel {
  id: string;
  label: string;
  /** The provider the harness names for it, where its id carries one. */
  provider?: string;
  /** The model the harness runs when none is named. */
  isDefault?: true;
  /** The model the harness said this one resolves to, where it differs from the id. */
  resolvesTo?: string;
  /** The model the harness names as this one's successor. */
  upgrade?: string;
  /** The efforts the harness offers for it. */
  efforts?: string[];
}

/** How a worker came by a catalog: the manifest's source kind, and the command it ran. */
export interface CatalogSource { kind: 'command' | 'exchange'; command: string }

/**
 * Whose login a list was made with: the machine's own (`worker-login`), as a run on the machine's own login is
 * started. A run the Deployment hands its own credential may be offered other models.
 */
export const CATALOG_SIGN_INS = ['worker-login'] as const;
export type CatalogSignIn = typeof CATALOG_SIGN_INS[number];

/** The models one worker listed for one harness, and when. */
export interface ModelCatalog {
  harness: string;
  source: CatalogSource;
  signIn: CatalogSignIn;
  fetchedAt: number;
  models: CatalogModel[];
  /** Set where the harness listed more than `MAX_CATALOG_MODELS`. */
  truncated?: true;
}

const catalogText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, max) : null;

/**
 * One listed model as a catalog keeps it, or null where its id is not one the harness's settings accept
 * (`modelPattern`): a model that cannot be chosen is not offered.
 */
export function catalogModel(harness: string, raw: unknown): CatalogModel | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === 'string' ? entry.id.trim() : null;
  if (id === null || id.length > MAX_CATALOG_ID_CHARS || modelRefusal(harness, id) !== null) return null;
  const provider = catalogText(entry.provider, MAX_CATALOG_ID_CHARS);
  const resolvesTo = catalogText(entry.resolvesTo, MAX_CATALOG_ID_CHARS);
  const upgrade = catalogText(entry.upgrade, MAX_CATALOG_ID_CHARS);
  const efforts = Array.isArray(entry.efforts)
    ? [...new Set(entry.efforts.map((effort) => catalogText(effort, MAX_CATALOG_EFFORT_CHARS)).filter((effort): effort is string => effort !== null))].slice(0, MAX_CATALOG_EFFORTS)
    : [];
  return {
    id, label: catalogText(entry.label, MAX_CATALOG_LABEL_CHARS) ?? id,
    ...(provider === null ? {} : { provider }),
    ...(entry.isDefault === true ? { isDefault: true as const } : {}),
    ...(resolvesTo === null || resolvesTo === id ? {} : { resolvesTo }),
    ...(upgrade === null || upgrade === id ? {} : { upgrade }),
    ...(efforts.length === 0 ? {} : { efforts }),
  };
}

/**
 * A catalog as the Deployment keeps one, or null where it names no harness whose models Settings configures, no
 * source, no login it was made with, or no time it was listed. Models the harness's settings would refuse, and repeats, are left out; past
 * `MAX_CATALOG_MODELS` the rest are cut and the catalog is marked `truncated`.
 */
export function parseModelCatalog(value: unknown): ModelCatalog | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const harness = typeof raw.harness === 'string' && CONFIGURABLE_PROFILE_HARNESSES.includes(raw.harness) ? raw.harness : null;
  const source = raw.source !== null && typeof raw.source === 'object' && !Array.isArray(raw.source) ? raw.source as Record<string, unknown> : null;
  const kind = source?.kind === 'command' || source?.kind === 'exchange' ? source.kind : null;
  const command = catalogText(source?.command, MAX_CATALOG_SOURCE_CHARS);
  const fetchedAt = typeof raw.fetchedAt === 'number' && Number.isSafeInteger(raw.fetchedAt) && raw.fetchedAt > 0 ? raw.fetchedAt : null;
  const signIn = CATALOG_SIGN_INS.find((value) => value === raw.signIn) ?? null;
  if (harness === null || kind === null || command === null || signIn === null || fetchedAt === null || !Array.isArray(raw.models)) return null;
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  let bytes = 0;
  let truncated = raw.truncated === true;
  for (const entry of raw.models) {
    const model = catalogModel(harness, entry);
    if (model === null || seen.has(model.id)) continue;
    bytes += new TextEncoder().encode(JSON.stringify(model)).length + 1;
    if (models.length >= MAX_CATALOG_MODELS || bytes > MAX_CATALOG_MODEL_BYTES) { truncated = true; break; }
    seen.add(model.id);
    models.push(model);
  }
  return { harness, source: { kind, command }, signIn, fetchedAt, models, ...(truncated ? { truncated: true as const } : {}) };
}

/** The presets a harness declares whose every model some catalog of the harness lists. */
export function offeredPresets(harness: string, catalogs: readonly Pick<ModelCatalog, 'harness' | 'models'>[]): ModelPreset[] {
  const listed = new Set(catalogs.filter((catalog) => catalog.harness === harness).flatMap((catalog) => catalog.models.map((model) => model.id)));
  return (PROFILE_HARNESSES[harness]?.presets ?? []).filter((preset) => REASONING_TIERS.every((tier) => listed.has(preset.models[tier])));
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
