import type { RelationalStore } from '../../core/adapters.js';
import { registeredObjectKeySql } from '../storage/registered-object-key.js';
import { PROCESSED_FIELDS, processedResourceProofSql } from '../processed-resources.js';
import { read, readSet } from '../index.js';

export interface ProcessedFieldRow {
  text: string | null;
  blob_key: string | null;
  object_key: string | null;
  registered_size: number | null;
  total_bytes: number | null;
  media_type: string | null;
  admitted: number;
}

/** The kinds of projected field a processed read serves from a relational row. */
export type ProcessedFieldKind = 'plan' | 'attachment';

const fieldRead = (kind: ProcessedFieldKind) => {
  const field = PROCESSED_FIELDS[kind];
  return read<[project: string, id: string], ProcessedFieldRow>({ name: `processedFields.${kind}`, sql: `SELECT ${field.text === null ? 'NULL' : `d.${field.text}`} AS text, d.${field.blob} AS blob_key,
      ${registeredObjectKeySql('d.project_id', `d.${field.blob}`)} AS object_key,
      (SELECT b.size FROM blobs b WHERE b.project_id = d.project_id AND b.key = d.${field.blob}) AS registered_size,
      NULL AS total_bytes,
      ${kind === 'attachment' ? 'd.media_type' : 'NULL'} AS media_type,
      ${processedResourceProofSql('d.project_id', kind, `d.${field.id}`, `d.${field.blob}`)} AS admitted${kind === 'attachment' ? '' : ', d.session_id AS __myco_session'}
    FROM ${field.table} d WHERE d.project_id = ?1 AND d.${field.id} = ?2` });
};
const reads = { plan: fieldRead('plan'), attachment: fieldRead('attachment') };

/** A plan's or attachment's body fields with the proof that its stored body is admitted, or null when the Project holds no such record. */
export async function processedFieldRow(db: RelationalStore, project: string, kind: ProcessedFieldKind, id: string): Promise<ProcessedFieldRow | null> {
  const [[row]] = await readSet(db, reads[kind].bind(project, id));
  return row ?? null;
}
