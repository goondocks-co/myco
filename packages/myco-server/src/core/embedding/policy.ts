/**
 * The embedding policy: which provider, model and endpoint compute this Deployment's vectors, resolved from the three
 * embedding leaves for the target the Deployment runs on.
 *
 * Pure: the same stored values and target always resolve the same selection. Search, the embedding run and the
 * settings surface all resolve through `resolveEmbedding`, so what Settings reports is what search uses.
 */
import {
  DEFAULT_EMBEDDING_PROVIDER, EMBEDDING_CATALOGUE, EMBEDDING_PROVIDERS, LEGACY_ENDPOINT_TARGETS, TARGET_LABELS, embeddingDimensions, embeddingProvidersFor, isEmbeddingProvider,
  type DeploymentTarget, type EmbeddingProviderId, type SettingSource, type SettingState,
} from '@goondocks/myco-shared/settings-contract';
import { VECTOR_DIMENSIONS } from './vectors.js';

export const EMBEDDING_PROVIDER_LEAF = 'embedding.provider';
export const EMBEDDING_MODEL_LEAF = 'embedding.model';
export const EMBEDDING_ENDPOINT_LEAF = 'embedding.base_url';
export const EMBEDDING_SELECTION_LEAVES = [EMBEDDING_PROVIDER_LEAF, EMBEDDING_MODEL_LEAF, EMBEDDING_ENDPOINT_LEAF] as const;
export type EmbeddingSelectionLeaf = typeof EMBEDDING_SELECTION_LEAVES[number];

/** The longest model id a leaf holds. */
const MODEL_MAX_CHARS = 256;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** What computes vectors: a provider, its model, and where requests go. */
export interface EmbeddingSelection {
  provider: EmbeddingProviderId;
  model: string;
  /** The request URL, or null for the platform binding. */
  url: string | null;
  dimensions: number | null;
  credential: 'openrouter' | 'openai' | null;
  /** The identity vectors are partitioned by: a change re-embeds every source under the new identity. */
  modelKey: string;
}

/** The stored embedding leaves, each as parsed JSON, or undefined where nothing is stored. */
export type StoredEmbedding = Partial<Record<EmbeddingSelectionLeaf, unknown>>;

/** What the Deployment has to compute vectors with. Absent, readiness is not judged: a write may name a provider before its key exists. */
export interface EmbeddingReadiness {
  workersAi: boolean;
  credentials: ReadonlySet<string>;
}

export interface EmbeddingLeafAnswer {
  effective: unknown;
  source: SettingSource;
  state: SettingState;
  reason: string | null;
}

export interface EmbeddingResolution {
  /** What search and the embedding run use, or null when semantic search is off. */
  selection: EmbeddingSelection | null;
  /** Why there is no selection, when there is none. */
  reason: string | null;
  leaves: Record<EmbeddingSelectionLeaf, EmbeddingLeafAnswer>;
}

const providerLabel = (id: EmbeddingProviderId): string => EMBEDDING_CATALOGUE[id].label;
const offered = (target: DeploymentTarget): string => embeddingProvidersFor(target).map(providerLabel).join(', ');

/** Why a model cannot be stored for a provider, or null. */
export function embeddingModelRefusal(provider: EmbeddingProviderId, model: unknown): string | null {
  const spec = EMBEDDING_CATALOGUE[provider];
  if (typeof model !== 'string' || model.trim() === '') return 'expected a model name';
  if (model !== model.trim() || model.length > MODEL_MAX_CHARS || CONTROL.test(model)) return `expected a model name of at most ${MODEL_MAX_CHARS} characters without spaces at either end`;
  const dimensions = embeddingDimensions(provider, model);
  if (dimensions === null && !spec.customModels) return `${spec.label} does not offer ${model}`;
  if (dimensions !== null && dimensions > VECTOR_DIMENSIONS) return tooLargeRefusal(model, dimensions);
  return null;
}

/** Why an endpoint cannot be stored, or null: an HTTP URL without credentials, a query or a fragment. */
export function embeddingEndpointRefusal(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'expected an endpoint URL';
  let url: URL;
  try { url = new URL(value); } catch { return 'expected an endpoint URL such as http://localhost:11434'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'expected an http or https endpoint';
  if (url.username !== '' || url.password !== '') return 'expected an endpoint without a user name or password';
  if (url.search !== '' || url.hash !== '') return 'expected an endpoint without a query or fragment';
  return null;
}

/** The request URL a provider's base endpoint resolves to. */
function requestUrl(provider: EmbeddingProviderId, base: string): string {
  const api = EMBEDDING_CATALOGUE[provider].api;
  return new URL(base.replace(/\/+$/, '') + (api === 'ollama' ? '/api/embed' : '/embeddings')).href;
}

/** The identity a selection's vectors are partitioned under. */
function modelKeyOf(provider: EmbeddingProviderId, model: string, url: string | null): string {
  const partition = EMBEDDING_CATALOGUE[provider].partition;
  return partition === undefined ? JSON.stringify([provider, model, url]) : JSON.stringify([partition, model]);
}

/** The provider and model a stored partition identity names, when the catalogue knows them. */
export function partitionModel(modelKey: string): { provider: EmbeddingProviderId; model: string } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(modelKey); } catch { return null; }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') return null;
  const provider = EMBEDDING_PROVIDERS.find((id) => EMBEDDING_CATALOGUE[id].partition === parsed[0]) ?? parsed[0];
  return isEmbeddingProvider(provider) ? { provider, model: parsed[1] } : null;
}

const answer = (effective: unknown, source: SettingSource, state: SettingState, reason: string | null = null): EmbeddingLeafAnswer =>
  ({ effective, source, state, reason: reason === null ? null : reason.charAt(0).toUpperCase() + reason.slice(1) });

/** Resolve the embedding leaves for a target. */
export function resolveEmbedding(stored: StoredEmbedding, target: DeploymentTarget, readiness?: EmbeddingReadiness): EmbeddingResolution {
  const fallback = DEFAULT_EMBEDDING_PROVIDER[target];
  const held = { provider: stored[EMBEDDING_PROVIDER_LEAF], model: stored[EMBEDDING_MODEL_LEAF], endpoint: stored[EMBEDDING_ENDPOINT_LEAF] };

  let provider: EmbeddingProviderId | null = fallback;
  let providerAnswer: EmbeddingLeafAnswer;
  if (held.provider === undefined) {
    providerAnswer = fallback === null
      ? answer(null, 'unset', 'inactive', 'No embedding provider is chosen, so search matches words only.')
      : answer(fallback, EMBEDDING_CATALOGUE[fallback].api === 'workers-ai' ? 'platform' : 'default', 'active');
  } else if (!isEmbeddingProvider(held.provider)) {
    providerAnswer = answer(fallback, 'invalid', 'invalid', `${JSON.stringify(held.provider)} is not an embedding provider. Reset it or choose one of: ${offered(target)}.`);
  } else if (!EMBEDDING_CATALOGUE[held.provider].targets.includes(target)) {
    providerAnswer = answer(fallback, fallback === null ? 'unset' : 'default', 'not-applicable',
      `${providerLabel(held.provider)} is not offered on ${TARGET_LABELS[target]}; this server offers ${offered(target)}. Reset the provider to use ${fallback === null ? 'none' : providerLabel(fallback)}.`);
  } else {
    provider = held.provider;
    providerAnswer = answer(provider, 'configured', 'active');
  }

  if (provider === null) {
    const none = (value: unknown) => value === undefined ? answer(null, 'unset', 'inactive', 'No embedding provider is chosen.')
      : answer(null, 'unset', 'not-applicable', 'No embedding provider is chosen, so this is not used. Reset it or choose a provider.');
    return { selection: null, reason: providerAnswer.reason, leaves: { [EMBEDDING_PROVIDER_LEAF]: providerAnswer, [EMBEDDING_MODEL_LEAF]: none(held.model), [EMBEDDING_ENDPOINT_LEAF]: none(held.endpoint) } };
  }

  const spec = EMBEDDING_CATALOGUE[provider];
  let model = spec.defaultModel;
  let modelAnswer: EmbeddingLeafAnswer;
  if (held.model === undefined) modelAnswer = answer(model, 'default', 'active');
  else {
    const refusal = embeddingModelRefusal(provider, held.model);
    if (refusal === null) { model = held.model as string; modelAnswer = answer(model, 'configured', 'active'); }
    else modelAnswer = answer(model, 'invalid', 'invalid', `${refusal}. Reset the model to use ${spec.defaultModel}, or choose another.`);
  }

  let base = spec.endpoint.url;
  let endpointAnswer: EmbeddingLeafAnswer;
  let credential = spec.credential;
  if (!spec.endpoint.editable) {
    const legacy = held.endpoint !== undefined && LEGACY_ENDPOINT_TARGETS.includes(target) && spec.api !== 'workers-ai' && embeddingEndpointRefusal(held.endpoint) === null;
    if (legacy) {
      base = held.endpoint as string;
      credential = null;
      endpointAnswer = answer(base, 'configured', 'invalid', `${spec.label} with an endpoint of its own is no longer offered. Search keeps sending requests to ${base}, without your ${spec.label} key, until you reset this to use ${spec.label}'s own endpoint and key, or choose ${EMBEDDING_CATALOGUE['openai-compatible'].label}.`);
    } else {
      endpointAnswer = held.endpoint === undefined ? answer(base, base === null ? 'platform' : 'default', 'active')
        : answer(base, base === null ? 'platform' : 'default', 'not-applicable', `${spec.label} uses its own endpoint, so this is not used. Reset it.`);
    }
  } else if (held.endpoint === undefined) {
    endpointAnswer = base === null ? answer(null, 'unset', 'inactive', `${spec.label} needs an endpoint.`) : answer(base, 'default', 'active');
  } else {
    const refusal = embeddingEndpointRefusal(held.endpoint);
    if (refusal === null) { base = held.endpoint as string; endpointAnswer = answer(base, 'configured', 'active'); }
    else endpointAnswer = answer(base, 'invalid', 'invalid', `${refusal}. Reset the endpoint${base === null ? '' : ` to use ${base}`}, or correct it.`);
  }

  const leaves = { [EMBEDDING_PROVIDER_LEAF]: providerAnswer, [EMBEDDING_MODEL_LEAF]: modelAnswer, [EMBEDDING_ENDPOINT_LEAF]: endpointAnswer };
  let reason: string | null = null;
  if (spec.api !== 'workers-ai' && base === null) reason = `${spec.label} needs an endpoint before search can use it.`;
  else if (readiness !== undefined && spec.api === 'workers-ai' && !readiness.workersAi) reason = 'Workers AI is not set up on this server, so search matches words only.';
  else if (readiness !== undefined && credential !== null && !readiness.credentials.has(credential)) {
    reason = `No ${spec.label} key is stored, so search matches words only. Add one under Provider keys.`;
  }
  if (reason !== null) {
    for (const leaf of EMBEDDING_SELECTION_LEAVES) if (leaves[leaf].state === 'active') leaves[leaf] = { ...leaves[leaf], state: 'inactive', reason };
    return { selection: null, reason, leaves };
  }
  const url = base === null ? null : requestUrl(provider, base);
  return {
    selection: { provider, model, url, dimensions: embeddingDimensions(provider, model), credential, modelKey: modelKeyOf(provider, model, url) },
    reason: null,
    leaves,
  };
}

/** One model whose vectors the index holds. */
export interface HeldPartition { modelKey: string; label: string; dimensions: number | null }

export function heldPartition(modelKey: string): HeldPartition {
  const named = partitionModel(modelKey);
  return { modelKey, label: named?.model ?? modelKey, dimensions: named === null ? null : embeddingDimensions(named.provider, named.model) };
}

/** Why a model change is held while search holds results built with the current model. */
export const SWITCH_REFUSAL = 'Switching the embedding model rebuilds search for every source. Choose Switch to this model to rebuild it in the background while search keeps using the current one';

/** Why a model cannot serve search on any server: its results are larger than search stores. */
export const tooLargeRefusal = (model: string, dimensions: number): string =>
  `${model} is too large for search: it has ${dimensions} dimensions and search stores at most ${VECTOR_DIMENSIONS}`;

/**
 * Why `candidate` cannot replace `current`, or null. While search holds any results, every change of the model
 * identity is refused: the change would retire every held result and leave search with nothing comparable until each
 * source is embedded again. With nothing held any model that fits may be chosen, and turning search off retires
 * nothing. Returning to a model whose results are still held is allowed when none is in use.
 */
export function selectionChangeRefusal(current: EmbeddingSelection | null, candidate: EmbeddingSelection | null, held: readonly HeldPartition[]): string | null {
  if (candidate === null) return null;
  if (candidate.dimensions !== null && candidate.dimensions > VECTOR_DIMENSIONS) return tooLargeRefusal(candidate.model, candidate.dimensions);
  if (candidate.modelKey === current?.modelKey || held.length === 0) return null;
  if (current === null && held.some((partition) => partition.modelKey === candidate.modelKey)) return null;
  return SWITCH_REFUSAL;
}

/** A standing switch's model owns calibration. */
export const calibrationModel = (model: string, switching: string | null): string => switching ?? model;
