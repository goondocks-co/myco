import type { RelationalStore } from '../adapters.js';
import { EmbeddingSwitchFailure, providerFailureAction, PROVIDER_PAUSE_RETRY_MS } from './provider-failure.js';

interface ProviderState { failures: number; retry_at: number | null }

/** A provider hold remains authoritative until its deadline or a configuration change. */
export async function embeddingProviderState(db: RelationalStore, model: string): Promise<ProviderState | null> {
  return db.prepare('SELECT failures,retry_at FROM embedding_provider_holds WHERE model_key=?').bind(model).first<ProviderState>();
}

export async function embeddingProviderReady(db: RelationalStore, model: string, now: number): Promise<boolean> {
  const held = await embeddingProviderState(db,model);
  return held === null || held.retry_at !== null && held.retry_at <= now;
}

/** The configuration generation fences failures from calls started with a superseded key or endpoint. */
export async function embeddingProviderRevision(db: RelationalStore): Promise<string> {
  return (await db.prepare("SELECT value FROM schema_meta WHERE key='embedding_provider_revision'").first<{ value: string }>())!.value;
}

export async function recordEmbeddingProviderFailure(db: RelationalStore, model: string, revision: string, error: unknown, now: number): Promise<void> {
  const prior = await embeddingProviderState(db,model);
  const action = providerFailureAction(error instanceof EmbeddingSwitchFailure ? error.failure : error,prior?.failures ?? 0,now);
  if (action.action === 'skip') return;
  await db.prepare(`INSERT INTO embedding_provider_holds(model_key,failures,retry_at,reason)
    SELECT ?,?,?,? WHERE (SELECT value FROM schema_meta WHERE key='embedding_provider_revision')=?
    ON CONFLICT(model_key) DO UPDATE SET failures=excluded.failures,retry_at=excluded.retry_at,reason=excluded.reason`)
    .bind(model,(prior?.failures ?? 0)+1,action.action === 'wait' ? action.until : now + PROVIDER_PAUSE_RETRY_MS,action.reason,revision).run();
}

export async function clearEmbeddingProviderHold(db:RelationalStore,model:string):Promise<void> {
  await db.prepare('DELETE FROM embedding_provider_holds WHERE model_key=?').bind(model).run();
}
