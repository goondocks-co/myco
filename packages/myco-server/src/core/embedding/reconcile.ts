import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_DELETE_CONFIRM_MS, VECTOR_DELETE_RETRY_MS, VECTOR_WRITE_TIMEOUT_MS, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { reconcileHubness } from './hubness.js';
import { registeredObjectKeySql } from '../blob-objects.js';

/**
 * `provider` writes every source and, unless `calibrate` names another model, calibrates spores. While an embedding
 * switch runs, `building` writes every source too, once `provider` has none left to write, skipping each source
 * `buildingHeld` (a condition over source `s`, binding nothing) holds; `retain` names every model whose vectors are kept:
 * a receipt under any other model is retired. With `retireOnly`, a step writes and calibrates nothing and only retires;
 * with `skipWrites`, it writes nothing and retires and calibrates.
 * `vectorWriteTimeoutMs` bounds each vector write and delete; it defaults to `VECTOR_WRITE_TIMEOUT_MS`.
 */
export interface EmbeddingContext {
  db: RelationalStore;
  blobs: BlobStore;
  vectors: VectorStore;
  provider: EmbeddingProvider;
  building?: EmbeddingProvider;
  buildingHeld?: string;
  retain?: readonly string[];
  calibrate?: string;
  retireOnly?: boolean;
  skipWrites?: boolean;
  vectorWriteTimeoutMs?: number;
}
export interface EmbeddingStep { phase: 'missing' | 'stale' | 'switch' | 'orphans' | 'hubness' | 'visibility' | 'settled'; processed: number }

/** Requeue a project's embedding sources when its vector namespace is empty. Source revisions remain intact. */
export async function resetEmbeddingIndex(db: RelationalStore, projectId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM embedding_receipts WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_cursors WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_hubness_members WHERE project_id = ?').bind(projectId),
    db.prepare('UPDATE embedding_versions SET attempted_at = 0 WHERE project_id = ?').bind(projectId),
  ]);
}

/** A source whose text cannot be read, under the model that asked for it: its stored body is missing or is not text. */
export class EmbeddingSourceUnreadable extends Error {
  constructor(readonly source: { projectId: string; type: string; recordId: string; revision: string }, readonly modelKey: string, readonly reason: string) {
    super(`embedding source ${source.type} ${source.recordId}: ${reason}`);
  }
}

/** Blob-backed plans use a bounded text prefix for their embedding. Full text remains in the search index. */
async function sourceText(blobs: BlobStore, source: EmbeddingSource & { object_key: string | null }, modelKey: string): Promise<string> {
  if (source.blob_key === null) return source.text;
  const unreadable = (reason: string) => new EmbeddingSourceUnreadable({ projectId: source.project_id, type: source.type, recordId: source.record_id, revision: source.revision }, modelKey, reason);
  const blob = source.object_key === null ? null : await blobs.get(source.object_key);
  if (blob === null) throw unreadable('its stored text is missing');
  const reader = blob.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = source.text;
  try {
    while (text.length < EMBEDDING_TEXT_CHARS) {
      const { done, value } = await reader.read();
      text += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) break;
    }
  } catch (error) {
    if (error instanceof TypeError) throw unreadable('its stored text is not readable text');
    throw error;
  } finally { await reader.cancel(); reader.releaseLock(); }
  return text.slice(0, EMBEDDING_TEXT_CHARS);
}

const metadataOf = (s: EmbeddingSource): VectorMetadata => ({ type: s.type, record_id: s.record_id, revision: s.revision,
  status: s.status, session_id: s.session_id, created_at: s.created_at, observation_type: s.observation_type,
  release_state: s.release_state, release_confidence: s.release_confidence });

/**
 * A receipt's `ready`: 0 while its write is journaled, 1 once indexed, and negative once its vector's deletion has begun.
 * Spore calibration returns an indexed spore receipt whose vector the store never returns to 0, counting it in
 * `rewrites`, and never moves a negative one.
 */
export const RECEIPT = { journaled: 0, ready: 1, deletionSent: -1, deletionFailed: -2 } as const;

/**
 * A receipt claimed for deletion stays claimed until it is retired: it is due again `VECTOR_DELETE_CONFIRM_MS` after a
 * delete is sent and `VECTOR_DELETE_RETRY_MS` after a delete fails or its confirmation finds the vector still stored,
 * whether or not its source is current. An unclaimed receipt is due at once when its vector no longer belongs to a current
 * source, or when it is under a model no longer retained. Binds: `deletionDueBinds(retained, now)`.
 */
export const DELETION_DUE = `((r.ready >= ${RECEIPT.journaled} AND (r.model_key NOT IN (SELECT value FROM json_each(?)) OR NOT EXISTS
  (SELECT 1 FROM embedding_sources s WHERE s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision)))
  OR (r.ready = ${RECEIPT.deletionSent} AND r.updated_at <= ?) OR (r.ready = ${RECEIPT.deletionFailed} AND r.updated_at <= ?))`;
export const deletionDueBinds = (retained: string | readonly string[], now: number): [string, number, number] =>
  [JSON.stringify(typeof retained === 'string' ? [retained] : [...new Set(retained)]), now - VECTOR_DELETE_CONFIRM_MS, now - VECTOR_DELETE_RETRY_MS];

/** Every model whose vectors a step keeps. */
export const retainedModels = (context: Pick<EmbeddingContext, 'provider' | 'building' | 'retain'>): string[] =>
  [...new Set([context.provider.modelKey, ...(context.building === undefined ? [] : [context.building.modelKey]), ...(context.retain ?? [])])];

/**
 * A source `s` needs no write while its revision's receipt under the model is indexed or claimed for deletion; a claimed
 * receipt is written afresh once it is retired. Binds: the model key.
 */
export const SOURCE_HELD = `EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
  AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready <> ${RECEIPT.journaled})`;

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
  if (context.retireOnly !== true && context.skipWrites !== true) {
    const written = await writeSource(context, context.provider, projectId, now)
      ?? (context.building === undefined ? null : await writeSource(context, context.building, projectId, now, context.buildingHeld));
    if (written !== null) return written;
  }
  const orphan = await db.prepare(`SELECT r.* FROM embedding_receipts r WHERE r.project_id = ? AND ${DELETION_DUE}
    ORDER BY r.updated_at, r.id LIMIT 1`).bind(projectId, ...deletionDueBinds(retainedModels(context), now))
    .first<{ id: string; model_key: string; type: VectorType; record_id: string; revision: string; ready: number }>();
  if (orphan !== null) {
    const partition = { projectId, modelKey: orphan.model_key };
    const receipt = [projectId, orphan.model_key, orphan.id] as const;
    const stamp = (ready: number) => db.prepare('UPDATE embedding_receipts SET ready = ?, updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ?')
      .bind(ready, now, ...receipt).run();
    const confirming = orphan.ready < RECEIPT.journaled;
    await stamp(RECEIPT.deletionSent);
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

/** Write one source `provider` holds no vector for, passing over each source `held` holds, or answer null when none is left. */
export async function writeSource(context: EmbeddingContext, provider: EmbeddingProvider, projectId: string, now: number, held?: string): Promise<EmbeddingStep | null> {
  const { db, blobs, vectors } = context;
  const limit = context.vectorWriteTimeoutMs ?? VECTOR_WRITE_TIMEOUT_MS;
  const scope = { projectId, modelKey: provider.modelKey };
  const cursor = await db.prepare('SELECT next_type FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ next_type: number }>();
  for (let offset = 0; offset < VECTOR_TYPES.length; offset++) {
    const index = ((cursor?.next_type ?? 0) + offset) % VECTOR_TYPES.length;
    const type = VECTOR_TYPES[index];
    const source = await db.prepare(`SELECT s.*, ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key, EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id) AS stale
      FROM embedding_sources s JOIN embedding_versions v ON v.project_id = s.project_id AND v.type = s.type AND v.record_id = s.record_id
      WHERE s.project_id = ? AND s.type = ? AND NOT ${SOURCE_HELD}${held === undefined ? '' : ` AND NOT (${held})`}
      ORDER BY stale, v.attempted_at, s.record_id LIMIT 1`).bind(projectId, type, provider.modelKey).first<EmbeddingSource & { object_key: string | null; stale: number }>();
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
    const values = await provider.embed(await sourceText(blobs, source, provider.modelKey));
    const phase = provider === context.building ? 'switch' : source.stale ? 'stale' : 'missing';
    const rejournaled = await db.prepare(`UPDATE embedding_receipts SET updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${RECEIPT.journaled}`)
      .bind(now, ...receipt).run();
    if (rejournaled.meta.changes !== 1) return { phase, processed: 0 };
    const landed = async () => {
      await db.prepare(`UPDATE embedding_receipts SET ready = ${RECEIPT.ready} WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${RECEIPT.journaled}
        AND EXISTS (SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?)`)
        .bind(...receipt, projectId, type, source.record_id, source.revision).run();
      await db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, ready, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${RECEIPT.deletionSent}, ?)
        ON CONFLICT(project_id, model_key, id) DO NOTHING`).bind(...receipt, type, source.record_id, source.revision, now).run();
    };
    await bounded(vectors.upsert(scope, [{ id, values, metadata: metadataOf(source) }]).then(landed), limit, 'vector write');
    return { phase, processed: 1 };
  }
  return null;
}
