import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_DELETE_CONFIRM_MS, VECTOR_DELETE_RETRY_MS, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { reconcileHubness } from './hubness.js';
import { registeredObjectKeySql } from '../blob-objects.js';

export interface EmbeddingContext { db: RelationalStore; blobs: BlobStore; vectors: VectorStore; provider: EmbeddingProvider }
export interface EmbeddingStep { phase: 'missing' | 'stale' | 'orphans' | 'hubness' | 'visibility' | 'settled'; processed: number }

/** Requeue a project's embedding sources when its vector namespace is empty. Source revisions remain intact. */
export async function resetEmbeddingIndex(db: RelationalStore, projectId: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM embedding_receipts WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_cursors WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM embedding_hubness_work WHERE project_id = ?').bind(projectId),
    db.prepare('UPDATE embedding_versions SET attempted_at = 0 WHERE project_id = ?').bind(projectId),
  ]);
}

/** Blob-backed plans use a bounded text prefix for their embedding. Full text remains in the search index. */
async function sourceText(blobs: BlobStore, source: EmbeddingSource & { object_key: string | null }): Promise<string> {
  if (source.blob_key === null) return source.text;
  const blob = source.object_key === null ? null : await blobs.get(source.object_key);
  if (blob === null) throw new Error('embedding source blob is missing');
  const reader = blob.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = source.text;
  try {
    while (text.length < EMBEDDING_TEXT_CHARS) {
      const { done, value } = await reader.read();
      text += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) break;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return text.slice(0, EMBEDDING_TEXT_CHARS);
}

const metadataOf = (s: EmbeddingSource): VectorMetadata => ({ type: s.type, record_id: s.record_id, revision: s.revision,
  status: s.status, session_id: s.session_id, created_at: s.created_at, observation_type: s.observation_type,
  release_state: s.release_state, release_confidence: s.release_confidence });

/** A receipt's `ready`: 0 while its write is journaled, 1 once indexed, and negative once its vector's deletion has begun. */
export const RECEIPT = { journaled: 0, ready: 1, deletionSent: -1, deletionFailed: -2 } as const;

/**
 * A receipt whose vector no longer belongs to a current source is due for deletion: at once while it may still be served,
 * `VECTOR_DELETE_CONFIRM_MS` after a delete is sent, and `VECTOR_DELETE_RETRY_MS` after a delete fails or its confirmation
 * finds the vector still stored. Binds: `deletionDueBinds(modelKey, now)`.
 */
export const DELETION_DUE = `(r.ready >= ${RECEIPT.journaled} OR (r.ready = ${RECEIPT.deletionSent} AND r.updated_at <= ?)
  OR (r.ready = ${RECEIPT.deletionFailed} AND r.updated_at <= ?)) AND (r.model_key <> ? OR NOT EXISTS
  (SELECT 1 FROM embedding_sources s WHERE s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision))`;
export const deletionDueBinds = (modelKey: string, now: number): [number, number, string] =>
  [now - VECTOR_DELETE_CONFIRM_MS, now - VECTOR_DELETE_RETRY_MS, modelKey];

/**
 * Each step advances the namespace cursor before external work and journals writes before sending them.
 *
 * A source write re-journals its receipt just before the upsert and abandons the write when the receipt has been claimed
 * for deletion. A deletion claims its receipt before the delete is sent. Only a later attempt, one confirmation window on,
 * retires the receipt, and only when the vector store no longer returns the vector: by then any write that could still
 * land for that id has landed, and the delete it resends is applied after it.
 */
export async function reconcileEmbedding(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  const { db, blobs, vectors, provider } = context;
  const scope = { projectId, modelKey: provider.modelKey };
  const cursor = await db.prepare('SELECT next_type FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ next_type: number }>();
  for (let offset = 0; offset < VECTOR_TYPES.length; offset++) {
    const index = ((cursor?.next_type ?? 0) + offset) % VECTOR_TYPES.length;
    const type = VECTOR_TYPES[index];
    const source = await db.prepare(`SELECT s.*, ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key, EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id) AS stale
      FROM embedding_sources s JOIN embedding_versions v ON v.project_id = s.project_id AND v.type = s.type AND v.record_id = s.record_id
      WHERE s.project_id = ? AND s.type = ? AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id
        AND r.type = s.type AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = 1)
      ORDER BY stale, v.attempted_at, s.record_id LIMIT 1`).bind(projectId, type, provider.modelKey).first<EmbeddingSource & { object_key: string | null; stale: number }>();
    if (source === null) continue;
    const id = await vectorId(scope, source.type, source.record_id, source.revision);
    const receipt = [projectId, provider.modelKey, id] as const;
    await db.batch([
      db.prepare(`INSERT INTO embedding_cursors(project_id, next_type) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next_type = excluded.next_type`).bind(projectId, (index + 1) % VECTOR_TYPES.length),
      db.prepare(`UPDATE embedding_versions SET attempted_at = ? WHERE project_id = ? AND type = ? AND record_id = ?`).bind(now, projectId, type, source.record_id),
      db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, model_key, id) DO UPDATE SET updated_at = excluded.updated_at, ready = MAX(ready, ${RECEIPT.journaled})`)
        .bind(...receipt, type, source.record_id, source.revision, now),
    ]);
    const values = await provider.embed(await sourceText(blobs, source));
    const phase = source.stale ? 'stale' : 'missing';
    const rejournaled = await db.prepare(`UPDATE embedding_receipts SET updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${RECEIPT.journaled}`)
      .bind(now, ...receipt).run();
    if (rejournaled.meta.changes !== 1) return { phase, processed: 0 };
    await vectors.upsert(scope, [{ id, values, metadata: metadataOf(source) }]);
    await db.prepare(`UPDATE embedding_receipts SET ready = ${RECEIPT.ready} WHERE project_id = ? AND model_key = ? AND id = ? AND ready = ${RECEIPT.journaled}
      AND EXISTS (SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?)`)
      .bind(...receipt, projectId, type, source.record_id, source.revision).run();
    return { phase, processed: 1 };
  }
  const orphan = await db.prepare(`SELECT r.* FROM embedding_receipts r WHERE r.project_id = ? AND ${DELETION_DUE}
    ORDER BY r.updated_at, r.id LIMIT 1`).bind(projectId, ...deletionDueBinds(provider.modelKey, now))
    .first<{ id: string; model_key: string; type: VectorType; record_id: string; revision: string; ready: number }>();
  if (orphan !== null) {
    const partition = { projectId, modelKey: orphan.model_key };
    const receipt = [projectId, orphan.model_key, orphan.id] as const;
    const stamp = (ready: number) => db.prepare('UPDATE embedding_receipts SET ready = ?, updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ?')
      .bind(ready, now, ...receipt).run();
    const confirming = orphan.ready < RECEIPT.journaled;
    await stamp(RECEIPT.deletionSent);
    try {
      await vectors.delete(partition, [{ id: orphan.id, type: orphan.type, recordId: orphan.record_id, revision: orphan.revision }]);
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
  return reconcileHubness(context, projectId);
}
