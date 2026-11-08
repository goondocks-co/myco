import type { RelationalStore } from '../adapters.js';
import { clearProviderHold, providerConfiguration, providerHold, recordProviderFailure } from '../../db/embeddings/work.js';
import { EmbeddingSwitchFailure, providerFailureAction, PROVIDER_PAUSE_RETRY_MS } from './provider-failure.js';

interface ProviderState { failures: number; retry_at: number | null }

/** A provider hold remains authoritative until its deadline or a configuration change. */
export async function embeddingProviderState(db: RelationalStore, model: string): Promise<ProviderState | null> {
  const held = await providerHold(db, model);
  return held === null ? null : { failures: held.failures, retry_at: held.retry_at };
}

export async function embeddingProviderReady(db: RelationalStore, model: string, now: number): Promise<boolean> {
  const held = await embeddingProviderState(db,model);
  return held === null || held.retry_at !== null && held.retry_at <= now;
}

/** The configuration generation fences failures from calls started with a superseded key or endpoint. */
export async function embeddingProviderRevision(db: RelationalStore): Promise<string> {
  return providerConfiguration(db);
}

/** Hold the model off after a failure of `attempt`, taken from the attempt clock, that ran under configuration `revision`. */
export async function recordEmbeddingProviderFailure(db: RelationalStore, model: string, revision: string, error: unknown, now: number, attempt: number): Promise<void> {
  const prior = await embeddingProviderState(db,model);
  const action = providerFailureAction(error instanceof EmbeddingSwitchFailure ? error.failure : error,prior?.failures ?? 0,now);
  if (action.action === 'skip') return;
  await recordProviderFailure(db, model, prior?.failures ?? 0, action.action === 'wait' ? action.until : now + PROVIDER_PAUSE_RETRY_MS, action.reason, revision, attempt);
}

/** A success of `attempt` under `revision` clears only a hold every failing attempt of which came before it. */
export async function clearEmbeddingProviderHold(db: RelationalStore, model: string, attempt: number, revision: string): Promise<void> {
  await clearProviderHold(db, model, attempt, revision);
}
