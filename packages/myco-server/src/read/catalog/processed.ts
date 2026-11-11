import type { ServerEnv as processed_import_ServerEnv } from "../../core/adapters.js";
import { PROCESSED_FIELDS as processed_import_PROCESSED_FIELDS } from "../../db/processed-resources.js";
import { processedFieldRow, type ProcessedFieldRow } from "../../db/documents/processed-fields.js";
import type { ReadScope as processed_import_ReadScope } from "../scope.js";

type processed_ProcessedBodyKind = keyof typeof processed_import_PROCESSED_FIELDS;

type processed_ProcessedTextKind = Exclude<processed_ProcessedBodyKind, 'attachment'>;

export type processed_ProcessedField = ProcessedFieldRow;

function processed_isProcessedBodyKind(kind: string): kind is processed_ProcessedBodyKind {
  return Object.hasOwn(processed_import_PROCESSED_FIELDS, kind);
}

/** A projected field whose inline value or exact stored-body provenance is admitted. */
async function processed_processedField(env: Pick<processed_import_ServerEnv, 'db'>, scope: processed_import_ReadScope, kind: processed_ProcessedBodyKind, id: string): Promise<processed_ProcessedField | null> {
  if (kind !== 'plan' && kind !== 'attachment') return null;
  const row = await processedFieldRow(env.db, scope.projectId, kind, id);
  if (row === null) return null;
  const inline = row.text !== null;
  if (!inline && row.blob_key !== null && row.admitted !== 1) return null;
  return row;
}

export { type processed_ProcessedBodyKind, type processed_ProcessedTextKind, processed_isProcessedBodyKind, processed_processedField };
