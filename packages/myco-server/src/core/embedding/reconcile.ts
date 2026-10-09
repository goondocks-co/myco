import type { BlobStore, RelationalStore } from '../adapters.js';
import { EMBEDDING_TEXT_CHARS, VECTOR_WRITE_TIMEOUT_MS, inputRefusal, type EmbeddingProvider } from './provider.js';
import { VECTOR_TYPES, vectorId, type VectorMetadata, type VectorStore, type VectorType } from './vectors.js';
import type { EmbeddingSource } from '../../read/embedding.js';
import { reconcileHubness } from './hubness.js';
import { registeredObjectKeySql } from '../blob-objects.js';
import { retiringReceipt, sourceSelectionQuery } from './selection.js';
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

/** The `model_key` of a passed-over source no model can read. */
export const ANY_MODEL = '';
/** How long a source a model's provider refused as input is passed over before that model is asked again. */
export const INPUT_REFUSAL_RETRY_MS = 24 * 60 * 60_000;

/**
 * Source `s`'s current revision is one embedding passes over under a model: its stored text cannot be read, or the model
 * refused it as input within `INPUT_REFUSAL_RETRY_MS`. Binds: `passedOverBinds(modelKey, now)`.
 */
export const PASSED_OVER = `(EXISTS (SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type
  AND f.record_id = s.record_id AND f.revision = s.revision AND f.model_key = '${ANY_MODEL}') OR EXISTS (
  SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type AND f.record_id = s.record_id
    AND f.revision = s.revision AND f.model_key = ? AND f.recorded_at > ?))`;
export const passedOverBinds = (modelKey: string, now: number): [string, number] => [modelKey, now - INPUT_REFUSAL_RETRY_MS];

/** A source embedding passes over, as Health and a switch list it: where it is, what it is, and why. */
export interface PassedOverSource {
  projectId: string;
  projectName: string | null;
  type: string;
  recordId: string;
  title: string;
  /** The model it is passed over under, or `ANY_MODEL` when its stored text cannot be read. */
  modelKey: string;
  reason: string;
  recordedAt: number;
}

/**
 * The current sources embedding passes over under any of `models` (and those no model can read), newest first, at most
 * `limit`, with how many there are in all; a source passed over for more than one reason is listed once, with its
 * latest. `notArchived` keeps to Projects that are not archived, and `unbuiltUnder` to sources holding no indexed
 * vector under that model.
 */
export async function passedOverSources(
  db: RelationalStore, models: readonly string[], now: number, options: { limit: number; notArchived?: boolean; unbuiltUnder?: string },
): Promise<{ sources: PassedOverSource[]; count: number }> {
  const scope = `FROM embedding_source_failures f JOIN embedding_sources s ON s.project_id = f.project_id AND s.type = f.type
    AND s.record_id = f.record_id AND s.revision = f.revision
    WHERE (f.model_key = '${ANY_MODEL}' OR (f.model_key IN (SELECT value FROM json_each(?)) AND f.recorded_at > ?))
    ${options.notArchived === true ? 'AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = s.project_id AND p.archived_at IS NULL)' : ''}
    ${options.unbuiltUnder === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type
      AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = ${RECEIPT.ready})`}`;
  const binds = [JSON.stringify(models), now - INPUT_REFUSAL_RETRY_MS, ...(options.unbuiltUnder === undefined ? [] : [options.unbuiltUnder])];
  const { results } = await db.prepare(`SELECT f.project_id AS projectId, (SELECT p.name FROM projects p WHERE p.project_id = f.project_id) AS projectName,
      f.type, f.record_id AS recordId, s.title, f.model_key AS modelKey, f.reason, MAX(f.recorded_at) AS recordedAt
    ${scope} GROUP BY f.project_id, f.type, f.record_id ORDER BY recordedAt DESC, f.record_id LIMIT ?`).bind(...binds, options.limit).all<PassedOverSource>();
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${scope} GROUP BY f.project_id, f.type, f.record_id)`).bind(...binds).first<{ n: number }>();
  return { sources: results, count: total?.n ?? 0 };
}

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
      const { sql, binds } = sourceSelectionQuery(projectId, type!, provider.modelKey, now, arm);
      selected = await db.prepare(sql).bind(...binds).first<{ record_id: string; revision: string }>();
      if (selected !== null) { stale = arm; break; }
    }
    if (selected === null) continue;
    const source = await db.prepare(`SELECT s.*, ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key
      FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?`)
      .bind(projectId, type, selected.record_id, selected.revision).first<EmbeddingSource & { object_key: string | null }>();
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

/** The earliest source refusal expiry under a model, read through its retry index. */
export async function embeddingFailureWakeAt(db: RelationalStore, projectId: string, model: string, now: number): Promise<number | null> {
  const row = await db.prepare(`SELECT recorded_at AS at FROM embedding_source_failures
    WHERE project_id = ? AND model_key = ? AND recorded_at > ? ORDER BY recorded_at LIMIT 1`)
    .bind(projectId, model, now - INPUT_REFUSAL_RETRY_MS).first<{ at: number }>();
  return row === null ? null : row.at + INPUT_REFUSAL_RETRY_MS;
}
