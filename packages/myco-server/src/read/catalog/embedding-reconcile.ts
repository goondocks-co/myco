import { INPUT_REFUSAL_RETRY_MS as EMBEDDING_INPUT_REFUSAL_RETRY_MS } from '../../db/embedding-due.js';
import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import { CURRENT_EMBEDDING_SOURCES as embedding_import_CURRENT_EMBEDDING_SOURCES } from "../../db/embedding-sources.js";
import { embeddingSourceSelect as embedding_import_embeddingSourceSelect } from "../../db/embedding-sources.js";
import type { RelationalStore as core_embedding_reconcile_import_RelationalStore } from "../../core/adapters.js";
import { registeredObjectKeySql as core_embedding_reconcile_import_registeredObjectKeySql } from "../../core/blob-objects.js";
import { RECEIPT as core_embedding_reconcile_import_RECEIPT } from "../../core/embedding/receipt-state.js";

/** The `model_key` of a passed-over source no model can read. */
const core_embedding_reconcile_ANY_MODEL = '';

/** How long a source a model's provider refused as input is passed over before that model is asked again. */
const core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS = EMBEDDING_INPUT_REFUSAL_RETRY_MS;

/**
 * Source `s`'s current revision is one embedding passes over under a model: its stored text cannot be read, or the model
 * refused it as input within `INPUT_REFUSAL_RETRY_MS`. Binds: `passedOverBinds(modelKey, now)`.
 */
const core_embedding_reconcile_PASSED_OVER = `(EXISTS (SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type
  AND f.record_id = s.record_id AND f.revision = s.revision AND f.model_key = '${core_embedding_reconcile_ANY_MODEL}') OR EXISTS (
  SELECT 1 FROM embedding_source_failures f WHERE f.project_id = s.project_id AND f.type = s.type AND f.record_id = s.record_id
    AND f.revision = s.revision AND f.model_key = ? AND f.recorded_at > ?))`;

const core_embedding_reconcile_passedOverBinds = (modelKey: string, now: number): [string, number] => [modelKey, now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS];

/** A source embedding passes over, as Health and a switch list it: where it is, what it is, and why. */
interface core_embedding_reconcile_PassedOverSource {
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
async function core_embedding_reconcile_passedOverSources(
  db: core_embedding_reconcile_import_RelationalStore, models: readonly string[], now: number, options: { limit: number; notArchived?: boolean; unbuiltUnder?: string },
): Promise<{ sources: core_embedding_reconcile_PassedOverSource[]; count: number }> {
  const failures = `WITH failures AS (
    SELECT f.* FROM projects p CROSS JOIN embedding_source_failures f
      WHERE f.project_id = p.project_id AND f.model_key = '${core_embedding_reconcile_ANY_MODEL}'
    UNION ALL
    SELECT f.* FROM projects p CROSS JOIN json_each(?) model CROSS JOIN embedding_source_failures f
      WHERE f.project_id = p.project_id AND f.model_key = model.value AND f.model_key <> '${core_embedding_reconcile_ANY_MODEL}' AND f.recorded_at > ?), source_failures AS (
    ${embedding_import_CURRENT_EMBEDDING_SOURCES.map(source => `SELECT f.*, s.title
      FROM failures f CROSS JOIN (${embedding_import_embeddingSourceSelect(source, "''")}) s
      CROSS JOIN embedding_versions v
      WHERE f.type = '${source.type}' AND s.project_id = f.project_id AND s.record_id = f.record_id
        AND v.project_id = f.project_id AND v.type = f.type AND v.record_id = f.record_id AND v.revision = f.revision`).join(' UNION ALL ')})`;
  const scope = `FROM source_failures f WHERE 1 = 1
    ${options.notArchived === true ? 'AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = f.project_id AND p.archived_at IS NULL)' : ''}
    ${options.unbuiltUnder === undefined ? '' : `AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = f.project_id AND r.type = f.type
      AND r.record_id = f.record_id AND r.revision = f.revision AND r.model_key = ? AND r.ready = ${core_embedding_reconcile_import_RECEIPT.ready})`}`;
  const binds = [JSON.stringify([...new Set(models)]), now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS, ...(options.unbuiltUnder === undefined ? [] : [options.unbuiltUnder])];
  const { results } = await db.prepare(`${failures} SELECT f.project_id AS projectId, (SELECT p.name FROM projects p WHERE p.project_id = f.project_id) AS projectName,
      f.type, f.record_id AS recordId, f.title, f.model_key AS modelKey, f.reason, MAX(f.recorded_at) AS recordedAt
    ${scope} GROUP BY f.project_id, f.type, f.record_id ORDER BY recordedAt DESC, f.record_id LIMIT ?`).bind(...binds, options.limit).all<core_embedding_reconcile_PassedOverSource>();
  const total = await db.prepare(`${failures} SELECT COUNT(*) AS n FROM (SELECT 1 ${scope} GROUP BY f.project_id, f.type, f.record_id)`).bind(...binds).first<{ n: number }>();
  return { sources: results, count: total?.n ?? 0 };
}

/** The earliest source refusal expiry under a model, read through its retry index. */
async function core_embedding_reconcile_embeddingFailureWakeAt(db: core_embedding_reconcile_import_RelationalStore, projectId: string, model: string, now: number): Promise<number | null> {
  const row = await db.prepare(`SELECT recorded_at AS at FROM embedding_source_failures
    WHERE project_id = ? AND model_key = ? AND recorded_at > ? ORDER BY recorded_at LIMIT 1`)
    .bind(projectId, model, now - core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS).first<{ at: number }>();
  return row === null ? null : row.at + core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS;
}

export function prepareEmbeddingSource(db: sessions_import_RelationalStore, projectId: string, type: string, recordId: string, revision: string) {
  return db.prepare(`SELECT s.*, ${core_embedding_reconcile_import_registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key
      FROM embedding_sources s WHERE s.project_id = ? AND s.type = ? AND s.record_id = ? AND s.revision = ?`).bind(projectId, type, recordId, revision);
}

export { type core_embedding_reconcile_PassedOverSource, core_embedding_reconcile_passedOverSources, core_embedding_reconcile_embeddingFailureWakeAt, core_embedding_reconcile_ANY_MODEL, core_embedding_reconcile_INPUT_REFUSAL_RETRY_MS, core_embedding_reconcile_PASSED_OVER, core_embedding_reconcile_passedOverBinds };
