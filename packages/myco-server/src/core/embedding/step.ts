import type { ServerEnv } from '../adapters.js';
import { missingSporeVectors, type MissingSporeVectors } from './hubness.js';
import { reconcileEmbedding, type EmbeddingContext, type EmbeddingStep } from './reconcile.js';
import { EmbeddingSwitchFailure, calibrationModel, completeEmbeddingSwitch, embeddingStepProviders, settleSwitchFailure } from './switch.js';
import { projectArchived, recordSwitchProgress } from './switch-store.js';

export type EmbeddingStepAnswer = { provider_unavailable: true } | (EmbeddingStep & { missing: MissingSporeVectors });

/**
 * Advance one Project's embedding by one bounded step: a source written under search's model, then under a switch's
 * model, a source passed over, calibration, or a retired vector. An archived Project's step only retires.
 *
 * While a switch stands, a failure of its model holds the model off or pauses the switch, and the step serves search's
 * own model alone. After a step of a standing switch, search moves to the switch's model once it is complete.
 */
export async function advanceEmbedding(env: ServerEnv, projectId: string, now: number): Promise<EmbeddingStepAnswer> {
  const providers = env.vectors === undefined ? null : await embeddingStepProviders(env, now);
  if (providers === null) return { provider_unavailable: true };
  const context: EmbeddingContext = {
    db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: providers.provider, retain: providers.retain,
    calibrate: calibrationModel(providers.provider.modelKey, providers.switching),
    ...(await projectArchived(env.db, projectId) ? { retireOnly: true } : {}),
  };
  const switchId = providers.switchId;
  let step: EmbeddingStep;
  try {
    step = await reconcileEmbedding(providers.building === undefined ? context : { ...context, building: providers.building }, projectId, now);
  } catch (error) {
    if (switchId === null || !(error instanceof EmbeddingSwitchFailure)) throw error;
    await settleSwitchFailure(env, switchId, providers.failures, error, now);
    step = providers.building === undefined ? { phase: 'switch', processed: 0 } : await reconcileEmbedding(context, projectId, now);
  }
  if (switchId !== null) {
    /** Whether the switch's own model wrote a vector this step. */
    const built = step.processed > 0 && (step.phase === 'switch' || (providers.building === undefined && providers.provider.modelKey === providers.switching && (step.phase === 'missing' || step.phase === 'stale')));
    if (built) await recordSwitchProgress(env.db, switchId, now);
    await completeEmbeddingSwitch(env, now);
  }
  return { ...step, missing: await missingSporeVectors(env.db, projectId, providers.provider.modelKey, now) };
}
