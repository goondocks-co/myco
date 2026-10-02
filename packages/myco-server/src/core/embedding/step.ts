import type { ServerEnv } from '../adapters.js';
import { missingSporeVectors, type MissingSporeVectors } from './hubness.js';
import { reconcileEmbedding, type EmbeddingContext, type EmbeddingStep } from './reconcile.js';
import { EmbeddingSwitchFailure, completeEmbeddingSwitch, embeddingStepProviders, pauseForFailure } from './switch.js';

export type EmbeddingStepAnswer = { provider_unavailable: true } | (EmbeddingStep & { missing: MissingSporeVectors });

/**
 * Advance one Project's embedding by one bounded step: a source written under search's model, then under a switch's
 * model, a retired vector, or calibration. A failure of the switch's model pauses the switch, and the step serves
 * search's own model alone. After a step that moved the switch, search moves to the switch's model once it is complete.
 */
export async function advanceEmbedding(env: ServerEnv, projectId: string, now: number): Promise<EmbeddingStepAnswer> {
  const providers = env.vectors === undefined ? null : await embeddingStepProviders(env, now);
  if (providers === null) return { provider_unavailable: true };
  const context: EmbeddingContext = { db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: providers.provider, retain: providers.retain };
  let step: EmbeddingStep;
  try {
    step = await reconcileEmbedding({ ...context, ...(providers.building === undefined ? {} : { building: providers.building }) }, projectId, now);
  } catch (error) {
    if (!(error instanceof EmbeddingSwitchFailure) || providers.switchId === null) throw error;
    await pauseForFailure(env, providers.switchId, error, now);
    step = providers.building === undefined ? { phase: 'switch', processed: 0 } : await reconcileEmbedding(context, projectId, now);
  }
  if (providers.switchId !== null) await completeEmbeddingSwitch(env, now);
  return { ...step, missing: await missingSporeVectors(env.db, projectId, providers.provider.modelKey, now) };
}
