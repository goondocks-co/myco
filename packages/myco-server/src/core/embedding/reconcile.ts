import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_DELETE_RETRY_MS, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { reconcileHubness } from './hubness.js';

export interface EmbeddingContext { db: RelationalStore; blobs: BlobStore; vectors: VectorStore; provider: EmbeddingProvider }
export interface EmbeddingStep { phase: 'missing' | 'stale' | 'orphans' | 'hubness' | 'visibility' | 'settled'; processed: number }

/** Blob-backed plans use a bounded text prefix for their embedding. Full text remains in the search index. */
async function sourceText(blobs: BlobStore, source: EmbeddingSource): Promise<string> {
  if (source.blob_key === null) return source.text;
  const blob = await blobs.get(`${source.project_id}/${source.blob_key}`);
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

/** Each step advances the namespace cursor before external work and journals writes before sending them. */
export async function reconcileEmbedding(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  const { db, blobs, vectors, provider } = context;
  const scope = { projectId, modelKey: provider.modelKey };
  const cursor = await db.prepare('SELECT next_type FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ next_type: number }>();
  for (let offset = 0; offset < VECTOR_TYPES.length; offset++) {
    const index = ((cursor?.next_type ?? 0) + offset) % VECTOR_TYPES.length;
    const type = VECTOR_TYPES[index];
    const source = await db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id) AS stale
      FROM embedding_sources s JOIN embedding_versions v ON v.project_id = s.project_id AND v.type = s.type AND v.record_id = s.record_id
      WHERE s.project_id = ? AND s.type = ? AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id
        AND r.type = s.type AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = 1)
      ORDER BY stale, v.attempted_at, s.record_id LIMIT 1`).bind(projectId, type, provider.modelKey).first<EmbeddingSource & { stale: number }>();
    if (source === null) continue;
    const id = await vectorId(scope, source.type, source.record_id, source.revision);
    await db.batch([
      db.prepare(`INSERT INTO embedding_cursors(project_id, next_type) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET next_type = excluded.next_type`).bind(projectId, (index + 1) % VECTOR_TYPES.length),
      db.prepare(`UPDATE embedding_versions SET attempted_at = ? WHERE project_id = ? AND type = ? AND record_id = ?`).bind(now, projectId, type, source.record_id),
      db.prepare(`INSERT INTO embedding_receipts(project_id, model_key, id, type, record_id, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, model_key, id) DO UPDATE SET updated_at = excluded.updated_at`).bind(projectId, provider.modelKey, id, type, source.record_id, source.revision, now),
    ]);
    const values = await provider.embed(await sourceText(blobs, source));
    await vectors.upsert(scope, [{ id, values, metadata: metadataOf(source) }]);
    await db.prepare(`UPDATE embedding_receipts SET ready = 1 WHERE project_id = ? AND model_key = ? AND id = ?
      AND EXISTS (SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?)`)
      .bind(projectId, provider.modelKey, id, projectId, type, source.record_id, source.revision).run();
    return { phase: source.stale ? 'stale' : 'missing', processed: 1 };
  }
  const orphan = await db.prepare(`SELECT r.* FROM embedding_receipts r WHERE r.project_id = ?
    AND (r.ready <> -1 OR r.updated_at <= ?) AND (r.model_key <> ? OR NOT EXISTS
      (SELECT 1 FROM embedding_sources s WHERE s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision))
    ORDER BY r.updated_at, r.id LIMIT 1`).bind(projectId, now - VECTOR_DELETE_RETRY_MS, provider.modelKey)
    .first<{ id: string; model_key: string; type: VectorType; record_id: string; revision: string }>();
  if (orphan !== null) {
    await vectors.delete({ projectId, modelKey: orphan.model_key }, [{ id: orphan.id, type: orphan.type, recordId: orphan.record_id, revision: orphan.revision }]);
    await db.prepare('UPDATE embedding_receipts SET ready = -1, updated_at = ? WHERE project_id = ? AND model_key = ? AND id = ?')
      .bind(now, projectId, orphan.model_key, orphan.id).run();
    return { phase: 'orphans', processed: 1 };
  }
  return reconcileHubness(context, projectId);
}
