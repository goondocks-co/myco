import { embeddingProviderReady, recordEmbeddingProviderFailure, clearEmbeddingProviderHold } from './provider-state.js';
import {
  claimReceiptDeletion,
  embeddingSource,
  journalSourceAttempt,
  nextDueSource,
  nextWriteType,
  passOverSource,
  prepareEmbeddingDue,
  rejournalSourceAttempt,
  retainEmbeddingModels,
  settleReceiptDeletion,
  settleSourceWrite,
  retiringReceipt,
} from '../../db/embeddings/work.js';

/** The `model_key` of a passed-over source no model can read. */
export const ANY_MODEL = '';
import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_WRITE_TIMEOUT_MS, inputRefusal, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { embedding_EmbeddingSource as EmbeddingSource } from '../../read/catalog/embedding.js';
import { reconcileHubness } from './hubness.js';
import { RECEIPT } from './receipt-state.js';

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
export interface EmbeddingStep { phase: 'missing' | 'stale' | 'switch' | 'passed-over' | 'orphans' | 'hubness' | 'vector-page' | 'visibility' | 'settled' | 'scan'; processed: number }

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
const retainedModels = (context: Pick<EmbeddingContext, 'provider' | 'building' | 'retain'>): string[] =>
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
  await retainEmbeddingModels(db,projectId,context.retireOnly === true ? [] : retainedModels(context));
  if (context.retireOnly !== true) {
    const written = await writeSource(context, context.provider, projectId, now)
      ?? (context.building === undefined ? null : await writeSource(context, context.building, projectId, now));
    if (written !== null) return written;
  }
  const orphan = await retiringReceipt(db, projectId, retainedModels(context), now);
  if (orphan !== null) {
    const partition = { projectId, modelKey: orphan.model_key };
    const deletion = { projectId, model: orphan.model_key, id: orphan.id, ready: orphan.ready, updatedAt: orphan.updated_at, at: now };
    const confirming = orphan.ready < RECEIPT.journaled;
    const claim = await claimReceiptDeletion(db, deletion);
    if (claim === null) return { phase: 'orphans', processed: 0 };
    try {
      await bounded(vectors.delete(partition, [{ id: orphan.id, type: orphan.type, recordId: orphan.record_id, revision: orphan.revision }]), limit, 'vector delete');
    } catch (error) {
      await settleReceiptDeletion(db, deletion, claim, 'failed');
      throw error;
    }
    if (confirming) {
      const [held] = await vectors.get(partition, [orphan.id]);
      await settleReceiptDeletion(db, deletion, claim, held === undefined ? 'confirmed' : 'failed');
    }
    return { phase: 'orphans', processed: 1 };
  }
  if (context.retireOnly === true) return { phase: 'settled', processed: 0 };
  return reconcileHubness(context.calibrate === undefined ? context : { ...context, retain: retainedModels(context), provider: { ...context.provider, modelKey: context.calibrate } }, projectId, now);
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
  if (!(await embeddingProviderReady(db,provider.modelKey,now))) return null;
  const due = await prepareEmbeddingDue(db, projectId, provider.modelKey);
  if (!due.ready) return {phase:'scan',processed:1};
  const scanning = due.more;
  const start = await nextWriteType(db, projectId);
  for (let offset = 0; offset < VECTOR_TYPES.length; offset++) {
    const index = (start + offset) % VECTOR_TYPES.length;
    const type = VECTOR_TYPES[index];
    const selected = await nextDueSource(db, projectId, provider.modelKey, type!, now);
    if (selected === null) continue;
    const stale = selected.stale;
    const source = await embeddingSource(db, projectId, type!, selected.record_id, selected.revision);
    if (source === null) continue;
    const id = await vectorId(scope, source.type, source.record_id, source.revision);
    const attempt = await journalSourceAttempt(db, { projectId, model: provider.modelKey, id, type: type!, recordId: source.record_id, revision: source.revision, at: now },
      (index + 1) % VECTOR_TYPES.length);
    const phase = provider === context.building ? 'switch' : stale ? 'stale' : 'missing';
    const passOver = (modelKey: string, reason: string) => passOverSource(db, attempt, modelKey, reason).then((): EmbeddingStep => ({ phase: 'passed-over', processed: 1 }));
    let text: string;
    try { text = await sourceText(blobs,source); }
    catch (error) {
      if (error instanceof EmbeddingSourceUnreadable) return passOver(ANY_MODEL,error.reason);
      throw error;
    }
    let values: number[];
    try { values = await provider.embed(text); }
    catch (error) {
      const refused = inputRefusal(error);
      if (refused !== null) return passOver(provider.modelKey, refused);
      await recordEmbeddingProviderFailure(db, provider.modelKey, attempt.config, error, now, attempt.seq);
      throw error;
    }
    await clearEmbeddingProviderHold(db, provider.modelKey, attempt.seq, attempt.config);
    if (!(await rejournalSourceAttempt(db, attempt))) return { phase, processed: 0 };
    await bounded(vectors.upsert(scope, [{ id, values, metadata: metadataOf(source) }]).then(() => settleSourceWrite(db, attempt)), limit, 'vector write');
    return { phase, processed: 1 };
  }
  return scanning ? { phase: 'scan', processed: 1 } : null;
}
