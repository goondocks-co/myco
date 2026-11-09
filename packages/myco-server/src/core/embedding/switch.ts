import { passedOverHealth } from '../../db/embeddings/health.js';
import { EmbeddingSwitchFailure, providerFailureAction as switchFailureAction } from './provider-failure.js';
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
import { EMBEDDING_CATALOGUE, embeddingDimensions, embeddingPrice, type EmbeddingSwitchEstimate, type EmbeddingSwitchStatus, type PassedOverList, type HealthPassedOverList } from '@goondocks/myco-shared/settings-contract';
import { heldPartitions, judgeEmbeddingChoice, storedEmbedding, writeSwitchedEmbedding, type EmbeddingChoice } from '../settings.js';
import { resolveSemanticSearch } from '../search.js';
import { deploymentLatestTaskRun } from '../../db/runs/claim.js';
import { sessions_listProjects as listProjects } from '../../read/catalog/sessions.js';
import { EMBEDDING_TEXT_CHARS, EmbeddingUnavailable, embeddingDiagnostic, inputRefusal, type EmbeddingProvider } from './provider.js';
import { ANY_MODEL } from './reconcile.js';
import {
  type PassedOverSource,
  switchComplete,
  switchEstimate,
  switchPassedOver,
} from '../../db/embeddings/switch.js';
import { modelProgress } from '../../db/embeddings/status.js';
import { SWITCH_REFUSAL, heldPartition, resolveEmbedding, selectionChangeRefusal, type EmbeddingSelection, type StoredEmbedding } from './policy.js';
import { calibrationPending } from './hubness.js';
import { VECTOR_DIMENSIONS } from './vectors.js';
import { EMBEDDING_TASK } from './task.js';
import { deleteSwitch, insertSwitch, pauseSwitch, readSwitch, resumeSwitch, waitSwitch, type EmbeddingSwitch } from './switch-store.js';

/** A rough count of the characters one token of embedding input carries, for the estimate shown before and during a switch. */
const CHARS_PER_TOKEN = 4;
/** How long a building switch may go without a new vector before it says why. */
export const SWITCH_STALL_MS = 30 * 60_000;

type SwitchRefusal = { reason: 'invalid_value' | 'conflict'; detail: string };
export type SwitchAnswer = { applied: true; switch: EmbeddingSwitchStatus | null } | { applied: false; refusal: SwitchRefusal };

/** What switching to a model would read and cost, shown before an admin confirms it. */
type SwitchEstimate = EmbeddingSwitchEstimate;
type EstimateAnswer = { applied: true; estimate: SwitchEstimate } | { applied: false; refusal: SwitchRefusal };

/** The stored choice a switch names, as the embedding leaves would hold it. */
const switchChoice = (sw: Pick<EmbeddingSwitch, 'provider' | 'model' | 'endpoint'>): StoredEmbedding =>
  ({ 'embedding.provider': sw.provider, 'embedding.model': sw.model, ...(sw.endpoint === null ? {} : { 'embedding.base_url': sw.endpoint }) });

/**
 * The new model's provider, every failure of which is an `EmbeddingSwitchFailure`, but for a refusal of one source's
 * text, which the embedding run passes over as it does for any model.
 */
const guarded = (provider: EmbeddingProvider): EmbeddingProvider => ({
  modelKey: provider.modelKey,
  embed: (text) => provider.embed(text).catch((error: unknown) => { throw inputRefusal(error) === null ? new EmbeddingSwitchFailure(error) : error; }),
});

/** The answer of a server that cannot resolve another model's provider. */
const CANNOT_BUILD = { provider: null, reason: 'This server cannot build search with another model.' } as const;

/** Every model whose vectors a switch keeps: the one it builds and the one search used when it started. */
const retainedBy = (sw: EmbeddingSwitch | null): string[] =>
  sw === null ? [] : [sw.modelKey, ...(sw.fromModelKey === null ? [] : [sw.fromModelKey])];

/** Why a switch's model no longer names the search built for it. */
const unresolved = (model: string): string => `This server now reads ${model} differently from when the switch started, so what was built for it no longer fits. Cancel the switch.`;

/**
 * Why a building switch has not moved for a while, from its model's failures and what its embedding runs did, or null
 * while it moves.
 */
async function stallReason(env: ServerEnv, sw: EmbeddingSwitch, lastMoved: number, now: number): Promise<string | null> {
  if (sw.state !== 'building' || now - lastMoved < SWITCH_STALL_MS) return null;
  const minutes = Math.floor((now - lastMoved) / 60_000);
  if (sw.retryAt !== null) return `Rebuilding search has not moved for ${minutes} minutes: the new model has failed ${sw.failures} ${sw.failures === 1 ? 'time' : 'times'} in a row.`;
  const latest = await deploymentLatestTaskRun(env.db, EMBEDDING_TASK, lastMoved);
  if (latest === null) return `No embedding run has started in the last ${minutes} minutes, so rebuilding search has not moved.`;
  if (latest.status === 'failed') return `Rebuilding search has not moved for ${minutes} minutes: the last embedding run failed (“${latest.error ?? 'no reason given'}”).`;
  return `Rebuilding search has not moved for ${minutes} minutes, though embedding runs keep starting.`;
}

/** A list of passed-over sources as a reader sees it. */
const passedOverView = (listed: { sources: ReadonlyArray<Pick<PassedOverSource, 'projectId' | 'projectName' | 'type' | 'title' | 'reason' | 'modelKey'>>; count: number }): PassedOverList => ({
  count: listed.count,
  sources: listed.sources.map((s) => ({ projectId: s.projectId, projectName: s.projectName, type: s.type, title: s.title, reason: s.reason, anyModel: s.modelKey === ANY_MODEL })),
});

/**
 * The switch under way, as Settings and Health show it, or null. Its progress is read from each Project's maintained
 * model totals and the passed-over membership, never from the sources: `progress` is `building` while the passed-over
 * membership is still catching up, or a Project's
 * model is still initializing or source state is catching up, and its counts are then partial, never a final zero.
 */
export async function embeddingSwitchStatus(env: ServerEnv, now: number): Promise<EmbeddingSwitchStatus | null> {
  const sw = await readSwitch(env.db);
  if (sw === null) return null;
  const [built, passed] = await Promise.all([modelProgress(env.db, sw.modelKey, now), switchPassedOver(env.db, sw.modelKey, now, sw.modelKey)]);
  // Sources are the same under every model: while the new model initializes, the model search uses counts them. A
  // Project not yet initialized under the new model holds no vector under it, so what it has built stays exact.
  const counted = built.state === 'ready' || sw.fromModelKey === null ? built : await modelProgress(env.db, sw.fromModelKey, now);
  const counting = passed.state === 'building' || (built.state !== 'ready' && counted.state !== 'ready');
  const progress = { state: counting ? 'building' as const : 'ready' as const, asOf: built.asOf };
  const total = counted.state === 'ready' ? counted.total : built.total;
  const done = Math.min(built.ready + passed.count, total);
  // The estimate grows with the sources, from the tokens each one read on average when the switch started.
  const estimatedTokens = sw.estimatedSources === 0 ? sw.estimatedTokens : Math.ceil(sw.estimatedTokens * Math.max(total, sw.estimatedSources) / sw.estimatedSources);
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
    stalled: await stallReason(env, sw, sw.progressedAt, now),
    done,
    total,
    progress: progress.state,
    asOf: progress.asOf,
    passedOver: passedOverView(passed),
    startedAt: sw.startedAt,
    estimatedTokens,
    estimatedUsd: price === null ? null : estimatedTokens / 1_000_000 * price,
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

/**
 * What switching to `selection` would read now, what it costs where the provider publishes a price, and the sources
 * known now to be passed over under it, which will have no search by meaning.
 */
async function estimateFor(env: ServerEnv, selection: Pick<EmbeddingSelection, 'provider' | 'model' | 'modelKey'>, now: number): Promise<SwitchEstimate> {
  const { sources, characters } = await switchEstimate(env.db, EMBEDDING_TEXT_CHARS);
  const estimatedTokens = Math.ceil(characters / CHARS_PER_TOKEN);
  const price = embeddingPrice(selection.provider, selection.model);
  const passed = await switchPassedOver(env.db, selection.modelKey, now, null);
  return {
    provider: selection.provider, model: selection.model, sources, estimatedTokens,
    estimatedUsd: price === null ? null : estimatedTokens / 1_000_000 * price, passedOver: passedOverView(passed), progress: passed.state,
  };
}

/** The sources search by meaning passes over under the model it uses and the model a switch builds, as Health lists them. */
export async function passedOverForHealth(env: ServerEnv, now: number): Promise<HealthPassedOverList> {
  const plan = await embeddingWorkPlan(env, now);
  const models = plan === null ? [] : [plan.model, ...(plan.switching === null ? [] : [plan.switching])];
  const result = await passedOverHealth(env.db, models, now);
  return result.state === 'building' ? result : { state: 'ready', ...passedOverView(result) };
}

/** What switching search to the model `choice` names would read and cost, judged as starting it is. */
export async function estimateEmbeddingSwitch(env: ServerEnv, choice: EmbeddingChoice, now: number): Promise<EstimateAnswer> {
  const judged = await judgeSwitch(env, choice);
  return judged.refusal !== null ? { applied: false, refusal: judged.refusal } : { applied: true, estimate: await estimateFor(env, judged.selection, now) };
}

/** Start switching search to the model `choice` names, judged as `estimateEmbeddingSwitch` judges it. */
export async function startEmbeddingSwitch(env: ServerEnv, choice: EmbeddingChoice, actor: string, now: number): Promise<SwitchAnswer> {
  const judged = await judgeSwitch(env, choice);
  if (judged.refusal !== null) return { applied: false, refusal: judged.refusal };
  const { selection, stored, current } = judged;
  const estimate = await estimateFor(env, selection, now);
  const recorded = await insertSwitch(env.db, {
    id: crypto.randomUUID(),
    provider: selection.provider,
    model: selection.model,
    endpoint: typeof stored['embedding.base_url'] === 'string' ? stored['embedding.base_url'] : null,
    modelKey: selection.modelKey,
    fromModelKey: current?.modelKey ?? null,
    estimatedTokens: estimate.estimatedTokens,
    estimatedSources: estimate.sources,
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

/** Resume the switch `id`, paused or held off its model after a failure, once the new model can be reached. */
export async function resumeEmbeddingSwitch(env: ServerEnv, id: string, now: number): Promise<SwitchAnswer> {
  const sw = await readSwitch(env.db);
  if (sw === null || sw.id !== id || (sw.state !== 'paused' && sw.retryAt === null)) return { applied: false, refusal: { reason: 'conflict', detail: 'That switch is not paused' } };
  const reachable = env.embeddingProviderFor === undefined ? CANNOT_BUILD : await env.embeddingProviderFor(switchChoice(sw));
  if (reachable.provider === null) return { applied: false, refusal: { reason: 'invalid_value', detail: reachable.reason.replace(/\.$/, '') } };
  if (!(await resumeSwitch(env.db, id, now))) return { applied: false, refusal: { reason: 'conflict', detail: 'That switch is not paused' } };
  return { applied: true, switch: await embeddingSwitchStatus(env, now) };
}

/**
 * Move search to the switch's model once every counted source holds a vector under it or is passed over, and every Project
 * is calibrated under it: the embedding leaves are written and the switch ends in one batch, which lands only while the
 * switch is still building and complete. Answers whether search moved.
 */
export async function completeEmbeddingSwitch(env: ServerEnv, now: number): Promise<boolean> {
  const sw = await readSwitch(env.db);
  if (sw === null || sw.state !== 'building' || !(await switchComplete(env.db, sw, now))) return false;
  for (const { projectId } of await listProjects(env.db)) if (await calibrationPending(env.db, projectId, sw.modelKey, now, false, retainedBy(sw))) return false;
  const choice = switchChoice(sw);
  if (resolveEmbedding(choice, env.platform.name).selection?.modelKey !== sw.modelKey) {
    await pauseSwitch(env.db, sw.id, unresolved(sw.model), now);
    return false;
  }
  return writeSwitchedEmbedding(env.db, choice, sw.startedBy, now, sw);
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

/** What one embedding step's context writes with: the provider search uses, a switch's provider while it is asked, and the models kept. */
interface EmbeddingStepProviders {
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

/**
 * Hold off or pause the switch `id` for a failure of its model, as `switchFailureAction` decides. A refusal of one
 * source never reaches here: the embedding run passes that source over.
 */
export async function settleSwitchFailure(env: ServerEnv, id: string, failures: number, error: EmbeddingSwitchFailure, now: number): Promise<void> {
  const action = switchFailureAction(error.failure, failures, now);
  if (action.action === 'wait') await waitSwitch(env.db, id, action.until, action.reason, now);
  else await pauseSwitch(env.db, id, action.reason, now);
}
