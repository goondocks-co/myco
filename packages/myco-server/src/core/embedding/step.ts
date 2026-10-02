import type { ServerEnv } from '../adapters.js';
import { missingSporeVectors, type MissingSporeVectors } from './hubness.js';
import { EmbeddingSourceUnreadable, reconcileEmbedding, writeSource, type EmbeddingContext, type EmbeddingStep } from './reconcile.js';
import { EmbeddingSwitchFailure, calibrationModel, completeEmbeddingSwitch, embeddingStepProviders, settleSwitchFailure } from './switch.js';
import { SKIPPED_SOURCE, clearSwitchWait, projectArchived, recordSkip } from './switch-store.js';

export type EmbeddingStepAnswer = { provider_unavailable: true } | (EmbeddingStep & { missing: MissingSporeVectors; unreadable?: string });

/**
 * Advance one Project's embedding by one bounded step: a source written under search's model, then under a switch's
 * model, calibration, or a retired vector. An archived Project's step only retires.
 *
 * While a switch stands: a failure of its model holds the model off or pauses the switch, and the step serves search's
 * own model alone; a source the switch's model cannot read is recorded as skipped; and when search's own model cannot
 * read a source, the step writes the switch's model instead, or retires and calibrates when it has nothing to write, and
 * reports that source. After a step of a standing
 * switch, search moves to the switch's model once it is complete.
 */
export async function advanceEmbedding(env: ServerEnv, projectId: string, now: number): Promise<EmbeddingStepAnswer> {
  const providers = env.vectors === undefined ? null : await embeddingStepProviders(env, now);
  if (providers === null) return { provider_unavailable: true };
  const context: EmbeddingContext = {
    db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: providers.provider, retain: providers.retain,
    calibrate: calibrationModel(providers.provider.modelKey, providers.switching),
    ...(await projectArchived(env.db, projectId) ? { retireOnly: true } : {}),
  };
  const withBuilding: EmbeddingContext = providers.building === undefined ? context : { ...context, building: providers.building, buildingHeld: SKIPPED_SOURCE };
  const switchId = providers.switchId;
  /** Whether the switch's own model wrote a vector this step. */
  let built = false;
  let unreadable: string | undefined;

  /** What a failure the switch's model met in this step does; `serveCurrent` answers the step search's own model takes instead. */
  const switchFailed = async (error: unknown, serveCurrent: () => Promise<EmbeddingStep>): Promise<EmbeddingStep> => {
    if (switchId === null) throw error;
    if (error instanceof EmbeddingSwitchFailure) {
      await settleSwitchFailure(env, switchId, providers.failures, error, now);
      return serveCurrent();
    }
    if (error instanceof EmbeddingSourceUnreadable && error.modelKey === providers.switching) {
      await recordSkip(env.db, switchId, error.source, error.reason, now);
      return { phase: 'switch', processed: 1 };
    }
    throw error;
  };
  const idle = async (): Promise<EmbeddingStep> => ({ phase: 'switch', processed: 0 });

  let step: EmbeddingStep;
  try {
    step = await reconcileEmbedding(withBuilding, projectId, now);
    built = (step.phase === 'switch' || (providers.building === undefined && providers.provider.modelKey === providers.switching)) && step.processed > 0;
  } catch (error) {
    if (error instanceof EmbeddingSourceUnreadable && providers.building !== undefined && error.modelKey === providers.provider.modelKey) {
      unreadable = error.message;
      try {
        const written = await writeSource(withBuilding, providers.building, projectId, now, SKIPPED_SOURCE);
        built = written !== null && written.processed > 0;
        step = written ?? await reconcileEmbedding({ ...withBuilding, skipWrites: true }, projectId, now);
      } catch (inner) { step = await switchFailed(inner, idle); }
    } else {
      step = await switchFailed(error, providers.building === undefined ? idle : () => reconcileEmbedding(context, projectId, now));
    }
  }
  if (switchId !== null) {
    if (built && providers.failures > 0) await clearSwitchWait(env.db, switchId, now);
    await completeEmbeddingSwitch(env, now);
  }
  const missing = await missingSporeVectors(env.db, projectId, providers.provider.modelKey, now);
  return { ...step, missing, ...(unreadable === undefined ? {} : { unreadable }) };
}
