import { core_embedding_reconcile_ANY_MODEL as ANY_MODEL } from '../../read/view-store.js';
export { core_embedding_reconcile_ANY_MODEL as ANY_MODEL, core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS as INPUT_REFUSAL_RETRY_MS } from '../../read/view-store.js';
import { prepareEmbeddingSelection, prepareEmbeddingSource, prepareEmbeddingReadyReceipt } from '../../read/view-store.js';
export { type core_embedding_reconcile_PassedOverSource as PassedOverSource, core_embedding_reconcile_passedOverSources as passedOverSources, core_embedding_reconcile_embeddingFailureWakeAt as embeddingFailureWakeAt } from "../../read/view-store.js";
import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_WRITE_TIMEOUT_MS, inputRefusal, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { reconcileHubness } from './hubness.js';
import { registeredObjectKeySql } from '../blob-objects.js';
import { retiringReceipt } from './selection.js';
import { RECEIPT } from './receipt-state.js';
export { RECEIPT } from './receipt-state.js';

/**
 * `provider` writes every source and, unless `calibrate` names another model, calibrates spores. While an embedding
 * switch runs, `building` writes every source too, once `provider` has none left to write; `retain` names every model
 * whose vectors are kept: a receipt under any other model is retired. With `retireOnly`, a step writes and calibrates
 * nothing and only retires. Every writer passes over a source embedding cannot use (`PASSED_OVER`).
 * `vectorWriteTimeoutMs` bounds each vector write and delete; it defaults to `VECTOR_WRITE_TIMEOUT_MS`.
 */
export interface EmbeddingContext {
  db: RelationalStore;
  blobs: BlobStore;
  vectors: VectorStore;
  provider: EmbeddingProvider;
  building?: EmbeddingProvider;
  retain?: readonly string[];
  calibrate?: string;
  retireOnly?: boolean;
  vectorWriteTimeoutMs?: number;
}
export interface EmbeddingStep { phase: 'missing' | 'stale' | 'switch' | 'passed-over' | 'orphans' | 'hubness' | 'visibility' | 'settled'; processed: number }

/** Requeue a project's embedding sources when its vector namespace is empty. Source revisions remain intact. */
export async function resetEmbeddingIndex(db: RelationalStore, projectId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM embedding_receipts WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_cursors WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_hubness_members WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_source_failures WHERE project_id = ?').bind(projectId),
    db.prepare('UPDATE embedding_versions SET attempted_at = 0 WHERE project_id = ?').bind(projectId),
  ]);
}

/** A source whose stored text cannot be read: its body is not stored, or is not text. */
class EmbeddingSourceUnreadable extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Decode one chunk of a stored body, refusing bytes that are not UTF-8 text as unreadable. */
function decoded(decoder: TextDecoder, value?: Uint8Array): string {
  try { return value === undefined ? decoder.decode() : decoder.decode(value, { stream: true }); }
  catch (error) { if (error instanceof TypeError) throw new EmbeddingSourceUnreadable('its stored text is not readable text'); throw error; }
}

/**
 * Blob-backed plans use a bounded text prefix for their embedding. Full text remains in the search index. A body that
 * is not stored, or whose bytes are not text, is unreadable; a read that fails is an error like any other.
 */
async function sourceText(blobs: BlobStore, source: EmbeddingSource & { object_key: string | null }): Promise<string> {
  if (source.blob_key === null) return source.text;
  const blob = source.object_key === null ? null : await blobs.get(source.object_key);
  if (blob === null) throw new EmbeddingSourceUnreadable('its stored text is missing');
  const reader = blob.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = source.text;
  try {
    while (text.length < EMBEDDING_TEXT_CHARS) {
      const { done, value } = await reader.read();
      text += decoded(decoder, done ? undefined : value);
      if (done) break;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return text.slice(0, EMBEDDING_TEXT_CHARS);
}

const metadataOf = (s: EmbeddingSource): VectorMetadata => ({ type: s.type, record_id: s.record_id, revision: s.revision,
  status: s.status, session_id: s.session_id, created_at: s.created_at, observation_type: s.observation_type,
  release_state: s.release_state, release_confidence: s.release_confidence });

/** Every model whose vectors a step keeps. */
export const retainedModels = (context: Pick<EmbeddingContext, 'provider' | 'building' | 'retain'>): string[] =>
  [...new Set([context.provider.modelKey, ...(context.building === undefined ? [] : [context.building.modelKey]), ...(context.retain ?? [])])];

/** The vector store call settles within `ms`, or the step fails. The deadline is the platform's own signal. */
async function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  const deadline = AbortSignal.timeout(ms);
  let onDeadline: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    onDeadline = () => reject(new Error(`${what} did not settle within ${ms} ms`));
    deadline.addEventListener('abort', onDeadline);
  });
  try { return await Promise.race([work, expired]); } finally { deadline.removeEventListener('abort', onDeadline!); }
}

/**
 * Each step advances the namespace cursor before external work and journals writes before sending them.
 *
 * A source write re-journals its receipt just before the upsert and abandons the write when the receipt has been claimed
 * for deletion; it never writes to a claimed receipt. A deletion claims its receipt before the delete is sent. Only a later
 * attempt, one confirmation window on, retires the receipt, and only when the vector store no longer returns the vector.
 * Every vector write and delete is bounded by `VECTOR_WRITE_TIMEOUT_MS`, well inside that window, so by the confirmation
 * any write sent for that id has settled or failed its step, and the delete the confirmation resends is applied after it.
 * A write that returns after its receipt is retired records a fresh claim, so its vector is deleted in turn.
 */
export async function reconcileEmbedding(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  const { db, vectors } = context;
  const limit = context.vectorWriteTimeoutMs ?? VECTOR_WRITE_TIMEOUT_MS;
  if (context.retireOnly !== true) {
    const written = await writeSource(context, context.provider, projectId, now)
      ?? (context.building === undefined ? null : await writeSource(context, context.building, projectId, now));
    if (written !== null) return written;
  }
  const orphan = await retiringReceipt(db, projectId, retainedModels(context), now);
  if (orphan !== null) {
    const partition = { projectId, modelKey: orphan.model_key };
    const receipt = [projectId, orphan.model_key, orphan.id] as const;
    const stamp = (ready: number) => db.prepare('UPDATE embedding_receipts SET ready = ?, updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ?')
      .bind(ready, now, ...receipt).run();
    const confirming = orphan.ready < RECEIPT.journaled;
    const claimed = await db.prepare(`UPDATE embedding_receipts SET ready = ?, updated_at = ?
      WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ? AND updated_at = ? RETURNING id`)
      .bind(RECEIPT.deletionSent, now, ...receipt, orphan.ready, orphan.updated_at).first<{ id: string }>();
    if (claimed === null) return { phase: 'orphans', processed: 0 };
    try {
      await bounded(vectors.delete(partition, [{ id: orphan.id, type: orphan.type, recordId: orphan.record_id, revision: orphan.revision }]), limit, 'vector delete');
    } catch (error) {
      await stamp(RECEIPT.deletionFailed);
      throw error;
    }
    if (confirming) {
      const [held] = await vectors.get(partition, [orphan.id]);
      if (held === undefined) await db.prepare('DELETE FROM embedding_receipts WHERE project_id = ? AND model_key = ? AND id = ?').bind(...receipt).run();
      else await stamp(RECEIPT.deletionFailed);
    }
    return { phase: 'orphans', processed: 1 };
  }
  if (context.retireOnly === true) return { phase: 'settled', processed: 0 };
  return reconcileHubness(context.calibrate === undefined ? context : { ...context, provider: { ...context.provider, modelKey: context.calibrate } }, projectId, now);
}

/**
 * Write one source `provider` holds no vector for, or answer null when none is left. A source whose stored text cannot
 * be read, or that the provider refuses as input, is recorded as passed over, saying why, under every model or
 * under this one, and the step goes on.
 */
async function writeSource(context: EmbeddingContext, provider: EmbeddingProvider, projectId: string, now: number): Promise<EmbeddingStep | null> {
  const { db, blobs, vectors } = context;
  const limit = context.vectorWriteTimeoutMs ?? VECTOR_WRITE_TIMEOUT_MS;
  const scope = { projectId, modelKey: provider.modelKey };
  const cursor = await db.prepare('SELECT next_type FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ next_type: number }>();
  for (let offset = 0; offset < VECTOR_TYPES.length; offset++) {
    const index = ((cursor?.next_type ?? 0) + offset) % VECTOR_TYPES.length;
    const type = VECTOR_TYPES[index];
    let selected: { record_id: string; revision: string } | null = null;
    let stale = false;
    for (const arm of [false, true]) {
      selected = await prepareEmbeddingSelection(db, projectId, type!, provider.modelKey, now, arm).first<{ record_id: string; revision: string }>();
      if (selected !== null) { stale = arm; break; }
    }
    if (selected === null) continue;
    const source = await prepareEmbeddingSource(db, projectId, type!, selected.record_id, selected.revision).first<EmbeddingSource & { object_key: string | null }>();
    if (source === null) continue;
    const id = await vectorId(scope, source.type, source.record_id, source.revision);
    const receipt = [projectId, provider.modelKey, id] as const;
    await db.batch([
      db.prepare(`INSERT INTO embedding_cursors(project_id, next_type) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next_type = excluded.next_type`).bind(projectId, (index + 1) % VECTOR_TYPES.length),
      db.prepare(`UPDATE embedding_versions SET attempted_at = ? WHERE project_id = ? AND type = ? AND record_id = ?`).bind(now, projectId, type, source.record_id),
      db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, model_key, id) DO UPDATE SET updated_at = excluded.updated_at`)
        .bind(...receipt, type, source.record_id, source.revision, now),
    ]);
    const phase = provider === context.building ? 'switch' : stale ? 'stale' : 'missing';
    const passOver = (modelKey: string, reason: string) => db.prepare(`INSERT INTO embedding_source_failures (project_id, type, record_id, model_key, revision, reason, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, type, record_id, model_key) DO UPDATE SET revision = excluded.revision, reason = excluded.reason, recorded_at = excluded.recorded_at`)
      .bind(projectId, type, source.record_id, modelKey, source.revision, reason, now).run().then((): EmbeddingStep => ({ phase: 'passed-over', processed: 1 }));
    let values: number[];
    try { values = await provider.embed(await sourceText(blobs, source)); }
    catch (error) {
      if (error instanceof EmbeddingSourceUnreadable) return passOver(ANY_MODEL, error.reason);
      const refused = inputRefusal(error);
      if (refused !== null) return passOver(provider.modelKey, refused);
      throw error;
    }
    const rejournaled = await db.prepare(`UPDATE embedding_receipts SET updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${RECEIPT.journaled} RETURNING id`)
      .bind(now, ...receipt).all();
    if (rejournaled.results.length !== 1) return { phase, processed: 0 };
    const landed = async () => {
      await db.prepare(`DELETE FROM embedding_source_failures WHERE project_id = ? AND type = ? AND record_id = ? AND model_key IN ('${ANY_MODEL}', ?)`)
        .bind(projectId, type, source.record_id, provider.modelKey).run();
      await prepareEmbeddingReadyReceipt(db, receipt, projectId, type!, source.record_id, source.revision).run();
      await db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, ready, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${RECEIPT.deletionSent}, ?)
        ON CONFLICT(project_id, model_key, id) DO NOTHING`).bind(...receipt, type, source.record_id, source.revision, now).run();
    };
    await bounded(vectors.upsert(scope, [{ id, values, metadata: metadataOf(source) }]).then(landed), limit, 'vector write');
    return { phase, processed: 1 };
  }
  return null;
}
