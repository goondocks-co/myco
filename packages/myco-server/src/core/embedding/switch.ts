/**
 * Switch embedding model: the one confirmed operation that moves search to another embedding model while search keeps
 * answering with the current one.
 *
 * Starting records the switch. While it stands, the embedding run writes every source under the new model as well as
 * the current one, and retires neither model's vectors. Once every source holds a vector under the new model, the
 * embedding leaves are written to it and the switch ends in one batch; the existing reconcile then retires the old
 * model's vectors. A failure of the new model pauses the switch, saying why, and leaves search as it was. Cancelling
 * ends the switch, and the existing reconcile retires the partial vectors.
 */
import type { ServerEnv } from '../adapters.js';
import { EMBEDDING_CATALOGUE, embeddingDimensions, embeddingPrice, type EmbeddingSwitchStatus } from '@goondocks/myco-shared/settings-contract';
import { heldPartitions, judgeEmbeddingChoice, storedEmbedding, writeSwitchedEmbedding, type EmbeddingChoice } from '../settings.js';
import { resolveSemanticSearch } from '../search.js';
import { EMBEDDING_TEXT_CHARS, EmbeddingUnavailable, type EmbeddingProvider } from './provider.js';
import { SWITCH_REFUSAL, heldPartition, resolveEmbedding, selectionChangeRefusal, type StoredEmbedding } from './policy.js';
import { VECTOR_DIMENSIONS } from './vectors.js';
import {
  completionCondition, completionDelete, deleteSwitch, insertSwitch, pauseSwitch, readSwitch, resumeSwitch, sourceCharacters, switchComplete, switchProgress,
  type EmbeddingSwitch,
} from './switch-store.js';

/** A rough count of the characters one token of embedding input carries, for the estimate shown before and during a switch. */
const CHARS_PER_TOKEN = 4;

export type SwitchRefusal = { reason: 'invalid_value' | 'conflict'; detail: string };
export type SwitchAnswer = { applied: true; switch: EmbeddingSwitchStatus | null } | { applied: false; refusal: SwitchRefusal };

/** The stored choice a switch names, as the embedding leaves would hold it. */
export const switchChoice = (sw: Pick<EmbeddingSwitch, 'provider' | 'model' | 'endpoint'>): StoredEmbedding =>
  ({ 'embedding.provider': sw.provider, 'embedding.model': sw.model, ...(sw.endpoint === null ? {} : { 'embedding.base_url': sw.endpoint }) });

/** A failure of the new model, which pauses the switch rather than failing the run. */
export class EmbeddingSwitchFailure extends Error {
  constructor(readonly failure: unknown) { super(failure instanceof Error ? failure.message : String(failure)); }
}

/** The new model's provider, every failure of which is an `EmbeddingSwitchFailure`. */
const guarded = (provider: EmbeddingProvider): EmbeddingProvider => ({
  modelKey: provider.modelKey,
  embed: (text) => provider.embed(text).catch((error: unknown) => { throw new EmbeddingSwitchFailure(error); }),
});

/** Why the new model failed, in the reader's words. */
export function switchFailureWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status === '401' || status === '403') return `The new model's provider refused the request (HTTP ${status}). Check its key under Provider keys, then resume.`;
  if (status === '429') return 'The new model\'s provider is limiting requests (HTTP 429): its quota or rate limit is reached. Resume once it allows more.';
  if (status !== undefined) return `The new model's provider answered HTTP ${status}. Resume to try again.`;
  if (/timed out/.test(message)) return 'The new model\'s provider did not answer in time. Resume to try again.';
  if (error instanceof EmbeddingUnavailable) return 'The new model\'s provider could not be reached. Resume once it is reachable.';
  if (/dimensions/.test(message)) return `The new model returns vectors larger than search stores (at most ${VECTOR_DIMENSIONS} dimensions). Cancel the switch.`;
  return `The new model failed: ${message}. Resume to try again.`;
}

/** The tokens a new model is estimated to read: every source's embedded text, with a blob-backed plan read up to its bounded prefix. */
async function estimatedTokens(env: ServerEnv): Promise<number> {
  return Math.ceil(await sourceCharacters(env.db, EMBEDDING_TEXT_CHARS) / CHARS_PER_TOKEN);
}

/** The answer of a Deployment that cannot resolve another model's provider. */
const CANNOT_BUILD = { provider: null, reason: 'This server cannot build search with another model.' } as const;

/** Every model whose vectors a switch keeps: the one it builds and the one search used when it started. */
const retainedBy = (sw: EmbeddingSwitch | null): string[] =>
  sw === null ? [] : [sw.modelKey, ...(sw.fromModelKey === null ? [] : [sw.fromModelKey])];

/** Why a switch's model cannot serve the search built for it. */
const unresolved = (model: string): string => `${model} no longer resolves to the search it was built for on this server. Cancel the switch.`;

/** The switch under way, as Settings and Health show it, or null. */
export async function embeddingSwitchStatus(env: ServerEnv): Promise<EmbeddingSwitchStatus | null> {
  const sw = await readSwitch(env.db);
  if (sw === null) return null;
  const { done, total } = await switchProgress(env.db, sw.modelKey);
  const price = embeddingPrice(sw.provider, sw.model);
  const from = sw.fromModelKey === null ? null : heldPartition(sw.fromModelKey);
  return {
    id: sw.id,
    provider: sw.provider,
    providerLabel: EMBEDDING_CATALOGUE[sw.provider].label,
    model: sw.model,
    dimensions: embeddingDimensions(sw.provider, sw.model),
    from: from === null ? null : { model: from.label, dimensions: from.dimensions },
    state: sw.state,
    reason: sw.reason,
    done,
    total,
    startedAt: sw.startedAt,
    estimatedTokens: sw.estimatedTokens,
    estimatedUsd: price === null ? null : sw.estimatedTokens / 1_000_000 * price,
  };
}

/**
 * Start switching search to the model `choice` names. Refused while a switch stands, for a choice the settings surface
 * would refuse, for a model the index cannot hold, for a model search can move to without rebuilding, and for one this
 * Deployment cannot reach now.
 */
export async function startEmbeddingSwitch(env: ServerEnv, choice: EmbeddingChoice, actor: string, now: number): Promise<SwitchAnswer> {
  const standing = await readSwitch(env.db);
  if (standing !== null) return { applied: false, refusal: { reason: 'conflict', detail: `A switch to ${standing.model} is already under way` } };
  const target = env.platform.name;
  const judged = judgeEmbeddingChoice(choice, target);
  if (judged.refusal !== null) return { applied: false, refusal: { reason: 'invalid_value', detail: 'detail' in judged.refusal ? judged.refusal.detail : judged.refusal.reason } };
  const { selection, stored } = judged;
  if (selection === null) return { applied: false, refusal: { reason: 'invalid_value', detail: 'Choose a provider and a model to switch to' } };
  const current = resolveEmbedding(await storedEmbedding(env.db), target).selection;
  const refusal = selectionChangeRefusal(current, selection, await heldPartitions(env.db));
  if (refusal === null) {
    return { applied: false, refusal: { reason: 'invalid_value', detail: 'Search can use this model without rebuilding; choose it directly' } };
  }
  if (refusal !== SWITCH_REFUSAL) return { applied: false, refusal: { reason: 'invalid_value', detail: refusal } };
  if (env.vectors === undefined || env.embeddingProviderFor === undefined) {
    return { applied: false, refusal: { reason: 'invalid_value', detail: CANNOT_BUILD.reason.replace(/\.$/, '') } };
  }
  const reachable = await env.embeddingProviderFor(stored);
  if (reachable.provider === null) return { applied: false, refusal: { reason: 'invalid_value', detail: reachable.reason.replace(/\.$/, '') } };
  const recorded = await insertSwitch(env.db, {
    id: crypto.randomUUID(),
    provider: selection.provider,
    model: selection.model,
    endpoint: typeof stored['embedding.base_url'] === 'string' ? stored['embedding.base_url'] : null,
    modelKey: selection.modelKey,
    fromModelKey: current?.modelKey ?? null,
    estimatedTokens: await estimatedTokens(env),
    startedAt: now,
    startedBy: actor,
  }, now);
  if (!recorded) return { applied: false, refusal: { reason: 'conflict', detail: 'Another switch started first' } };
  return { applied: true, switch: await embeddingSwitchStatus(env) };
}

/** Cancel the switch `id`: search keeps its current model, and the existing reconcile retires the partial vectors. */
export async function cancelEmbeddingSwitch(env: ServerEnv, id: string): Promise<SwitchAnswer> {
  if (!(await deleteSwitch(env.db, id))) return { applied: false, refusal: { reason: 'conflict', detail: 'That switch is no longer under way' } };
  return { applied: true, switch: null };
}

/** Resume the paused switch `id`, once the new model can be reached. */
export async function resumeEmbeddingSwitch(env: ServerEnv, id: string, now: number): Promise<SwitchAnswer> {
  const sw = await readSwitch(env.db);
  if (sw === null || sw.id !== id || sw.state !== 'paused') return { applied: false, refusal: { reason: 'conflict', detail: 'That switch is not paused' } };
  const reachable = env.embeddingProviderFor === undefined ? CANNOT_BUILD : await env.embeddingProviderFor(switchChoice(sw));
  if (reachable.provider === null) return { applied: false, refusal: { reason: 'invalid_value', detail: reachable.reason.replace(/\.$/, '') } };
  if (!(await resumeSwitch(env.db, id, now))) return { applied: false, refusal: { reason: 'conflict', detail: 'That switch is not paused' } };
  return { applied: true, switch: await embeddingSwitchStatus(env) };
}

/**
 * Move search to the switch's model once every source holds a vector under it: the embedding leaves are written and the
 * switch ends in one batch, which lands only while the switch is still building and complete. Answers whether search moved.
 */
export async function completeEmbeddingSwitch(env: ServerEnv, now: number): Promise<boolean> {
  const sw = await readSwitch(env.db);
  if (sw === null || sw.state !== 'building' || !(await switchComplete(env.db, sw.modelKey))) return false;
  const choice = switchChoice(sw);
  if (resolveEmbedding(choice, env.platform.name).selection?.modelKey !== sw.modelKey) {
    await pauseSwitch(env.db, sw.id, unresolved(sw.model), now);
    return false;
  }
  return writeSwitchedEmbedding(env.db, choice, sw.startedBy, now, completionCondition(sw), completionDelete(env.db, sw));
}

/** The models embedding work writes and keeps on this Deployment: the one search uses, the one a switch builds, and every model a switch retains. */
export interface EmbeddingWorkPlan {
  /** The model every source is written under first: the one search uses, or a switch's model when none is in use. */
  model: string;
  /** A switch's model, written once `model` has nothing left to write. */
  building: string | null;
  retain: string[];
}

export async function embeddingWorkPlan(env: ServerEnv): Promise<EmbeddingWorkPlan | null> {
  if (env.vectors === undefined) return null;
  const current = await resolveSemanticSearch(env);
  const sw = await readSwitch(env.db);
  const building = sw?.state === 'building' ? sw.modelKey : null;
  const model = current?.provider.modelKey ?? building;
  if (model === null) return null;
  return {
    model,
    building: building === model ? null : building,
    retain: retainedBy(sw),
  };
}

/** What one embedding step's context writes with: the provider search uses, a switch's provider, and the models kept. */
export interface EmbeddingStepProviders {
  provider: EmbeddingProvider;
  building?: EmbeddingProvider;
  retain: string[];
  switchId: string | null;
}

/**
 * The providers one embedding step writes with. A switch whose model cannot be reached is paused, saying why; the
 * step then serves search's own model alone. Null when there is nothing to write with.
 */
export async function embeddingStepProviders(env: ServerEnv, now: number): Promise<EmbeddingStepProviders | null> {
  const current = await resolveSemanticSearch(env);
  const sw = await readSwitch(env.db);
  let building: EmbeddingProvider | null = null;
  if (sw?.state === 'building') {
    const answer = env.embeddingProviderFor === undefined
      ? CANNOT_BUILD
      : await env.embeddingProviderFor(switchChoice(sw));
    if (answer.provider === null) await pauseSwitch(env.db, sw.id, answer.reason.replace(/, so search matches words only/, ''), now);
    else if (answer.provider.modelKey !== sw.modelKey) await pauseSwitch(env.db, sw.id, unresolved(sw.model), now);
    else building = guarded(answer.provider);
  }
  const retain = retainedBy(sw);
  if (current !== null) return { provider: current.provider, ...(building === null ? {} : { building }), retain, switchId: sw?.id ?? null };
  return building === null ? null : { provider: building, retain, switchId: sw!.id };
}

/** Pause the switch `id` for a failure of its model. */
export const pauseForFailure = (env: ServerEnv, id: string, error: EmbeddingSwitchFailure, now: number): Promise<boolean> =>
  pauseSwitch(env.db, id, switchFailureWords(error.failure), now);
