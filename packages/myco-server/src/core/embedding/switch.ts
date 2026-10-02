/**
 * Switch embedding model: the one confirmed operation that moves search to another embedding model while search keeps
 * answering with the current one.
 *
 * Starting records the switch. While it stands, the embedding run writes every source of every Project that is not
 * archived under the new model as well as the current one, and retires neither model's vectors; spores are
 * calibrated under the new model as its vectors land. Once every such source holds a vector under
 * the new model, or is recorded as one it cannot read, and each Project is calibrated, the embedding leaves are written
 * to it and the switch ends in one batch; the existing reconcile then retires the replaced model's vectors. A failure the
 * provider may recover from holds the new model off for a while and tries again; one that needs an admin pauses the
 * switch, saying why. Search keeps its model throughout. Cancelling ends the switch, and the existing reconcile
 * retires the partial vectors.
 */
import type { ServerEnv } from '../adapters.js';
import { EMBEDDING_CATALOGUE, embeddingDimensions, embeddingPrice, type EmbeddingSwitchEstimate, type EmbeddingSwitchStatus } from '@goondocks/myco-shared/settings-contract';
import { heldPartitions, judgeEmbeddingChoice, storedEmbedding, writeSwitchedEmbedding, type EmbeddingChoice } from '../settings.js';
import { resolveSemanticSearch } from '../search.js';
import { deploymentLatestTaskRun } from '../runs.js';
import { listProjects } from '../../read/sessions.js';
import { EMBEDDING_TEXT_CHARS, EmbeddingUnavailable, type EmbeddingProvider } from './provider.js';
import { SWITCH_REFUSAL, heldPartition, resolveEmbedding, selectionChangeRefusal, type EmbeddingSelection, type StoredEmbedding } from './policy.js';
import { calibrationPending } from './hubness.js';
import { VECTOR_DIMENSIONS } from './vectors.js';
import { EMBEDDING_TASK } from './task.js';
import {
  completionCondition, completionStatements, deleteSwitch, insertSwitch, lastBuiltAt, pauseSwitch, readSwitch, resumeSwitch,
  skipReasons, sourceTotals, switchComplete, switchProgress, waitSwitch, type EmbeddingSwitch,
} from './switch-store.js';

/** A rough count of the characters one token of embedding input carries, for the estimate shown before and during a switch. */
const CHARS_PER_TOKEN = 4;
/** The first wait after the new model fails in a way it may recover from; each failure after doubles it, up to `RETRY_MAX_MS`. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** How long a building switch may go without a new vector before it says why. */
export const SWITCH_STALL_MS = 30 * 60_000;

export type SwitchRefusal = { reason: 'invalid_value' | 'conflict'; detail: string };
export type SwitchAnswer = { applied: true; switch: EmbeddingSwitchStatus | null } | { applied: false; refusal: SwitchRefusal };

/** What switching to a model would read and cost, shown before an admin confirms it. */
export type SwitchEstimate = EmbeddingSwitchEstimate;
export type EstimateAnswer = { applied: true; estimate: SwitchEstimate } | { applied: false; refusal: SwitchRefusal };

/** The stored choice a switch names, as the embedding leaves would hold it. */
export const switchChoice = (sw: Pick<EmbeddingSwitch, 'provider' | 'model' | 'endpoint'>): StoredEmbedding =>
  ({ 'embedding.provider': sw.provider, 'embedding.model': sw.model, ...(sw.endpoint === null ? {} : { 'embedding.base_url': sw.endpoint }) });

/** A failure of the new model, which holds off or pauses the switch rather than failing the run. */
export class EmbeddingSwitchFailure extends Error {
  constructor(readonly failure: unknown) { super(failure instanceof Error ? failure.message : String(failure)); }
}

/** The new model's provider, every failure of which is an `EmbeddingSwitchFailure`. */
const guarded = (provider: EmbeddingProvider): EmbeddingProvider => ({
  modelKey: provider.modelKey,
  embed: (text) => provider.embed(text).catch((error: unknown) => { throw new EmbeddingSwitchFailure(error); }),
});

/** What a failure of the new model does to the switch: hold the model off until `until`, or pause for an admin. */
export type SwitchFailureAction = { pause: true; reason: string } | { pause: false; until: number; reason: string };

/** The wait after the switch's `failures`-th failure in a row. */
const backoff = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 16));

/**
 * What a failure of the new model does, in the reader's words. A provider that is busy, slow, unreachable or out of its
 * daily quota is asked again later; one that turns the key down, refuses the request, or answers with results too large
 * for search pauses the switch until an admin acts.
 */
export function switchFailureAction(error: unknown, failures: number, now: number): SwitchFailureAction {
  const later = (reason: string, at = now + backoff(failures)): SwitchFailureAction => ({ pause: false, until: at, reason });
  if (error instanceof EmbeddingUnavailable) {
    const failure = error.failure;
    switch (failure.kind) {
      case 'quota':
        return later(`The new model's daily allowance is used up (“${failure.detail}”). Myco tries again when it renews.`, failure.resetsAt);
      case 'timeout':
        return later('The new model\'s provider did not answer in time. Myco tries again shortly.');
      case 'unreachable':
        return later(failure.detail === null
          ? 'Myco could not reach the new model\'s provider. It tries again shortly.'
          : `The new model's provider could not answer (“${failure.detail}”). Myco tries again shortly.`);
      case 'http': {
        const { status } = failure;
        if (status === 401 || status === 403) return { pause: true, reason: `The new model's provider turned down its key (HTTP ${status}). Check the key under Provider keys, then resume.` };
        if (status === 429) return later('The new model\'s provider asked Myco to slow down (HTTP 429). Myco tries again when it allows more.', now + Math.max(backoff(failures), failure.retryAfterMs ?? 0));
        if (status >= 500 || status === 408) return later(`The new model's provider had a problem (HTTP ${status}). Myco tries again shortly.`);
        return { pause: true, reason: `The new model's provider refused the request (HTTP ${status}). Check the model name and the server it runs on, then resume.` };
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/dimensions/.test(message)) {
    return { pause: true, reason: `The new model's results are too large for search, which holds up to ${VECTOR_DIMENSIONS} numbers for each. Cancel the switch and choose a smaller model.` };
  }
  return { pause: true, reason: 'The new model\'s provider answered with something search cannot use. Check the model name, then resume.' };
}

/** The answer of a server that cannot resolve another model's provider. */
const CANNOT_BUILD = { provider: null, reason: 'This server cannot build search with another model.' } as const;

/** Every model whose vectors a switch keeps: the one it builds and the one search used when it started. */
const retainedBy = (sw: EmbeddingSwitch | null): string[] =>
  sw === null ? [] : [sw.modelKey, ...(sw.fromModelKey === null ? [] : [sw.fromModelKey])];

/** Why a switch's model no longer names the search built for it. */
const unresolved = (model: string): string => `This server now reads ${model} differently from when the switch started, so what was built for it no longer fits. Cancel the switch.`;

/** Why a building switch has not moved for a while, from what its embedding runs did, or null while it moves. */
async function stallReason(env: ServerEnv, sw: EmbeddingSwitch, lastMoved: number, now: number): Promise<string | null> {
  if (sw.state !== 'building' || sw.retryAt !== null || now - lastMoved < SWITCH_STALL_MS) return null;
  const minutes = Math.floor((now - lastMoved) / 60_000);
  const latest = await deploymentLatestTaskRun(env.db, EMBEDDING_TASK, lastMoved);
  if (latest === null) return `No embedding run has started in the last ${minutes} minutes, so rebuilding search has not moved.`;
  if (latest.status === 'failed') return `Rebuilding search has not moved for ${minutes} minutes: the last embedding run failed (“${latest.error ?? 'no reason given'}”).`;
  return `Rebuilding search has not moved for ${minutes} minutes, though embedding runs keep starting.`;
}

/** The switch under way, as Settings and Health show it, or null. */
export async function embeddingSwitchStatus(env: ServerEnv, now: number): Promise<EmbeddingSwitchStatus | null> {
  const sw = await readSwitch(env.db);
  if (sw === null) return null;
  const [{ done, skipped, total }, built, reasons] = await Promise.all([switchProgress(env.db, sw.modelKey), lastBuiltAt(env.db, sw.modelKey), skipReasons(env.db)]);
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
    retryAt: sw.state === 'building' ? sw.retryAt : null,
    stalled: await stallReason(env, sw, Math.max(sw.startedAt, built ?? 0), now),
    done,
    total,
    skipped: { count: skipped, reasons },
    startedAt: sw.startedAt,
    estimatedTokens: sw.estimatedTokens,
    estimatedUsd: price === null ? null : sw.estimatedTokens / 1_000_000 * price,
  };
}

/**
 * Judge switching search to the model `choice` names: refused while a switch stands, for a choice the settings surface
 * would refuse, for a model the index cannot hold, for a model search can move to without rebuilding, and for one this
 * server cannot reach now.
 */
async function judgeSwitch(env: ServerEnv, choice: EmbeddingChoice): Promise<{ refusal: SwitchRefusal } | { refusal: null; selection: EmbeddingSelection; stored: StoredEmbedding; current: EmbeddingSelection | null }> {
  const standing = await readSwitch(env.db);
  if (standing !== null) return { refusal: { reason: 'conflict', detail: `A switch to ${standing.model} is already under way` } };
  const target = env.platform.name;
  const judged = judgeEmbeddingChoice(choice, target);
  if (judged.refusal !== null) return { refusal: { reason: 'invalid_value', detail: 'detail' in judged.refusal ? judged.refusal.detail : judged.refusal.reason } };
  const { selection, stored } = judged;
  if (selection === null) return { refusal: { reason: 'invalid_value', detail: 'Choose a provider and a model to switch to' } };
  const current = resolveEmbedding(await storedEmbedding(env.db), target).selection;
  const refusal = selectionChangeRefusal(current, selection, await heldPartitions(env.db));
  if (refusal === null) return { refusal: { reason: 'invalid_value', detail: 'Search can use this model without rebuilding; choose it directly' } };
  if (refusal !== SWITCH_REFUSAL) return { refusal: { reason: 'invalid_value', detail: refusal } };
  if (env.vectors === undefined || env.embeddingProviderFor === undefined) return { refusal: { reason: 'invalid_value', detail: CANNOT_BUILD.reason.replace(/\.$/, '') } };
  const reachable = await env.embeddingProviderFor(stored);
  if (reachable.provider === null) return { refusal: { reason: 'invalid_value', detail: reachable.reason.replace(/\.$/, '') } };
  return { refusal: null, selection, stored, current };
}

/** What switching to `selection` would read now, and what it costs where the provider publishes a price. */
async function estimateFor(env: ServerEnv, selection: Pick<EmbeddingSelection, 'provider' | 'model'>): Promise<SwitchEstimate> {
  const { sources, characters } = await sourceTotals(env.db, EMBEDDING_TEXT_CHARS);
  const estimatedTokens = Math.ceil(characters / CHARS_PER_TOKEN);
  const price = embeddingPrice(selection.provider, selection.model);
  return { provider: selection.provider, model: selection.model, sources, estimatedTokens, estimatedUsd: price === null ? null : estimatedTokens / 1_000_000 * price };
}

/** What switching search to the model `choice` names would read and cost, judged as starting it is. */
export async function estimateEmbeddingSwitch(env: ServerEnv, choice: EmbeddingChoice): Promise<EstimateAnswer> {
  const judged = await judgeSwitch(env, choice);
  return judged.refusal !== null ? { applied: false, refusal: judged.refusal } : { applied: true, estimate: await estimateFor(env, judged.selection) };
}

/** Start switching search to the model `choice` names, judged as `estimateEmbeddingSwitch` judges it. */
export async function startEmbeddingSwitch(env: ServerEnv, choice: EmbeddingChoice, actor: string, now: number): Promise<SwitchAnswer> {
  const judged = await judgeSwitch(env, choice);
  if (judged.refusal !== null) return { applied: false, refusal: judged.refusal };
  const { selection, stored, current } = judged;
  const recorded = await insertSwitch(env.db, {
    id: crypto.randomUUID(),
    provider: selection.provider,
    model: selection.model,
    endpoint: typeof stored['embedding.base_url'] === 'string' ? stored['embedding.base_url'] : null,
    modelKey: selection.modelKey,
    fromModelKey: current?.modelKey ?? null,
    estimatedTokens: (await estimateFor(env, selection)).estimatedTokens,
    startedAt: now,
    startedBy: actor,
  }, now);
  if (!recorded) return { applied: false, refusal: { reason: 'conflict', detail: 'Another switch started first' } };
  return { applied: true, switch: await embeddingSwitchStatus(env, now) };
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
  return { applied: true, switch: await embeddingSwitchStatus(env, now) };
}

/**
 * Move search to the switch's model once every counted source holds a vector under it or is skipped, and every Project
 * is calibrated under it: the embedding leaves are written and the switch ends in one batch, which lands only while the
 * switch is still building and complete. Answers whether search moved.
 */
export async function completeEmbeddingSwitch(env: ServerEnv, now: number): Promise<boolean> {
  const sw = await readSwitch(env.db);
  if (sw === null || sw.state !== 'building' || !(await switchComplete(env.db, sw.modelKey))) return false;
  for (const { projectId } of await listProjects(env.db)) if (await calibrationPending(env.db, projectId, sw.modelKey, now)) return false;
  const choice = switchChoice(sw);
  if (resolveEmbedding(choice, env.platform.name).selection?.modelKey !== sw.modelKey) {
    await pauseSwitch(env.db, sw.id, unresolved(sw.model), now);
    return false;
  }
  return writeSwitchedEmbedding(env.db, choice, sw.startedBy, now, completionCondition(sw), completionStatements(env.db, sw));
}

/** Whether a standing switch's model is asked now: building, and not held off after a failure. */
const asking = (sw: EmbeddingSwitch | null, now: number): sw is EmbeddingSwitch =>
  sw !== null && sw.state === 'building' && (sw.retryAt === null || sw.retryAt <= now);

/** The models embedding work writes and keeps on this server: the one search uses, the one a switch builds, and every model a switch retains. */
export interface EmbeddingWorkPlan {
  /** The model every source is written under first: the one search uses, or a switch's model when none is in use. */
  model: string;
  /** A switch's model, written once `model` has nothing left to write, while it is asked. */
  building: string | null;
  retain: string[];
  /** A standing switch's model, which spores are calibrated under while it stands. */
  switching: string | null;
}

export async function embeddingWorkPlan(env: ServerEnv, now: number): Promise<EmbeddingWorkPlan | null> {
  if (env.vectors === undefined) return null;
  const current = await resolveSemanticSearch(env);
  const sw = await readSwitch(env.db);
  const building = asking(sw, now) ? sw.modelKey : null;
  const model = current?.provider.modelKey ?? building;
  if (model === null) return null;
  return { model, building: building === model ? null : building, retain: retainedBy(sw), switching: sw?.modelKey ?? null };
}

/**
 * The model a Project's spores are calibrated under: a standing switch's, whose spores join calibration as their vectors
 * land, else `model`. Spores written under the current model meanwhile keep the statistics they hold.
 */
export const calibrationModel = (model: string, switching: string | null): string => switching ?? model;

/** What one embedding step's context writes with: the provider search uses, a switch's provider while it is asked, and the models kept. */
export interface EmbeddingStepProviders {
  provider: EmbeddingProvider;
  building?: EmbeddingProvider;
  retain: string[];
  switchId: string | null;
  switching: string | null;
  failures: number;
}

/**
 * The providers one embedding step writes with. A switch whose model cannot be reached is paused, saying why; the step
 * then serves search's own model alone, as it does while the switch's model is held off. Null when there is nothing to
 * write with.
 */
export async function embeddingStepProviders(env: ServerEnv, now: number): Promise<EmbeddingStepProviders | null> {
  const current = await resolveSemanticSearch(env);
  const sw = await readSwitch(env.db);
  let building: EmbeddingProvider | null = null;
  if (asking(sw, now)) {
    const answer = env.embeddingProviderFor === undefined ? CANNOT_BUILD : await env.embeddingProviderFor(switchChoice(sw));
    if (answer.provider === null) await pauseSwitch(env.db, sw.id, answer.reason.replace(/, so search matches words only/, ''), now);
    else if (answer.provider.modelKey !== sw.modelKey) await pauseSwitch(env.db, sw.id, unresolved(sw.model), now);
    else building = guarded(answer.provider);
  }
  const held = { retain: retainedBy(sw), switchId: sw?.id ?? null, switching: sw?.modelKey ?? null, failures: sw?.failures ?? 0 };
  if (current !== null) return { provider: current.provider, ...(building === null ? {} : { building }), ...held };
  return building === null ? null : { provider: building, ...held };
}

/** Hold off or pause the switch `id` for a failure of its model, as `switchFailureAction` decides. */
export async function settleSwitchFailure(env: ServerEnv, id: string, failures: number, error: EmbeddingSwitchFailure, now: number): Promise<void> {
  const action = switchFailureAction(error.failure, failures, now);
  if (action.pause) await pauseSwitch(env.db, id, action.reason, now);
  else await waitSwitch(env.db, id, action.until, action.reason, now);
}
