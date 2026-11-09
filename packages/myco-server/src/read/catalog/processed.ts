import type { ServerEnv as processed_import_ServerEnv } from "../../core/adapters.js";
import { registeredObjectKeySql as processed_import_registeredObjectKeySql } from "../../core/blob-objects.js";
import { PROCESSED_FIELDS as processed_import_PROCESSED_FIELDS } from "../../db/processed-resources.js";
import { processedResourceProofSql as processed_import_processedResourceProofSql } from "../../db/processed-resources.js";
import type { ReadScope as processed_import_ReadScope } from "../scope.js";

type processed_ProcessedBodyKind = keyof typeof processed_import_PROCESSED_FIELDS;

type processed_ProcessedTextKind = Exclude<processed_ProcessedBodyKind, 'attachment'>;

export interface processed_ProcessedField {
  text: string | null;
  blob_key: string | null;
  object_key: string | null;
  registered_size: number | null;
  total_bytes: number | null;
  media_type: string | null;
  admitted: number;
}

function processed_isProcessedBodyKind(kind: string): kind is processed_ProcessedBodyKind {
  return Object.hasOwn(processed_import_PROCESSED_FIELDS, kind);
}

/** A projected field whose inline value or exact stored-body provenance is admitted. */
async function processed_processedField(env: Pick<processed_import_ServerEnv, 'db'>, scope: processed_import_ReadScope, kind: processed_ProcessedBodyKind, id: string): Promise<processed_ProcessedField | null> {
  if (kind !== 'plan' && kind !== 'attachment') return null;
  const field = processed_import_PROCESSED_FIELDS[kind];
  const sql = `SELECT ${field.text === null ? 'NULL' : `d.${field.text}`} AS text, d.${field.blob} AS blob_key,
      ${processed_import_registeredObjectKeySql('d.project_id', `d.${field.blob}`)} AS object_key,
      (SELECT b.size FROM blobs b WHERE b.project_id = d.project_id AND b.key = d.${field.blob}) AS registered_size,
      NULL AS total_bytes,
      ${kind === 'attachment' ? 'd.media_type' : 'NULL'} AS media_type,
      ${processed_import_processedResourceProofSql('d.project_id', kind, `d.${field.id}`, `d.${field.blob}`)} AS admitted${kind === 'attachment' ? '' : ', d.session_id AS __myco_session'}
    FROM ${field.table} d WHERE d.project_id = ? AND d.${field.id} = ?`;
  const row = await env.db.prepare(sql).bind(scope.projectId, id).first<processed_ProcessedField>();
  if (row === null) return null;
  const inline = row.text !== null;
  if (!inline && row.blob_key !== null && row.admitted !== 1) return null;
  return row;
}

export { type processed_ProcessedBodyKind, type processed_ProcessedTextKind, processed_isProcessedBodyKind, processed_processedField };
