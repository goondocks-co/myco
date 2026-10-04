import type { ServerEnv } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { PROCESSED_FIELDS, processedResourceProofSql } from '../core/processed-resources.js';
import type { ReadScope } from './scope.js';

export type ProcessedBodyKind = keyof typeof PROCESSED_FIELDS;

export function isProcessedBodyKind(kind: string): kind is ProcessedBodyKind {
  return Object.hasOwn(PROCESSED_FIELDS, kind);
}

/** A processed field's complete text in its Project; no raw event or transcript is a target. */
export async function processedBody(env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, kind: ProcessedBodyKind, id: string): Promise<string | null> {
  const field = PROCESSED_FIELDS[kind];
  const row = await env.db.prepare(`SELECT d.${field.text} AS text, d.${field.blob} AS blob_key,
      ${registeredObjectKeySql('d.project_id', `d.${field.blob}`)} AS object_key,
      ${processedResourceProofSql('d.project_id', kind, `d.${field.id}`, `d.${field.blob}`)} AS admitted
    FROM ${field.table} d WHERE d.project_id = ? AND d.${field.id} = ?`)
    .bind(scope.projectId, id).first<{ text: string | null; blob_key: string | null; object_key: string | null; admitted: number }>();
  if (row === null) return null;
  if (row.text !== null && kind !== 'tool-output') return row.text;
  // Tool output keeps a preview alongside its spilled body.
  if (row.blob_key === null) return row.text;
  if (row.admitted !== 1) throw new Error('Processed body has no admitted field provenance');
  if (row.object_key === null) throw new Error('Processed body has no registered stored object');
  const object = await env.blobs.get(row.object_key);
  if (object === null) throw new Error('Processed body stored object is missing');
  return new Response(object.body).text();
}
