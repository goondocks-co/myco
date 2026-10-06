import type { ServerEnv, StoredObjectBody } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { PROCESSED_FIELDS, processedResourceProofSql } from '../core/processed-resources.js';
import { sha256HexOf, utf8 } from '../hash.js';
import type { ReadScope } from './scope.js';

export type ProcessedBodyKind = keyof typeof PROCESSED_FIELDS;
export type ProcessedTextKind = Exclude<ProcessedBodyKind, 'attachment'>;

interface ProcessedField {
  text: string | null;
  blob_key: string | null;
  object_key: string | null;
  registered_size: number | null;
  total_bytes: number | null;
  media_type: string | null;
  admitted: number;
}

export function isProcessedBodyKind(kind: string): kind is ProcessedBodyKind {
  return Object.hasOwn(PROCESSED_FIELDS, kind);
}

/** A projected field whose inline value or exact stored-body provenance is admitted. */
async function processedField(env: Pick<ServerEnv, 'db'>, scope: ReadScope, kind: ProcessedBodyKind, id: string): Promise<ProcessedField | null> {
  const field = PROCESSED_FIELDS[kind];
  const row = await env.db.prepare(`SELECT ${field.text === null ? 'NULL' : `d.${field.text}`} AS text, d.${field.blob} AS blob_key,
      ${registeredObjectKeySql('d.project_id', `d.${field.blob}`)} AS object_key,
      (SELECT b.size FROM blobs b WHERE b.project_id = d.project_id AND b.key = d.${field.blob}) AS registered_size,
      ${kind === 'tool-input' ? 'd.input_bytes' : 'NULL'} AS total_bytes,
      ${kind === 'attachment' ? 'd.media_type' : 'NULL'} AS media_type,
      ${processedResourceProofSql('d.project_id', kind, `d.${field.id}`, `d.${field.blob}`)} AS admitted
    FROM ${field.table} d WHERE d.project_id = ? AND d.${field.id} = ?`)
    .bind(scope.projectId, id).first<ProcessedField>();
  if (row === null) return null;
  if (kind === 'tool-input' && row.blob_key === null && row.text !== null && row.total_bytes !== null && row.total_bytes > utf8(row.text).byteLength) {
    throw new Error('Processed tool input has a truncated prefix without its complete body');
  }
  const inline = row.text !== null && kind !== 'tool-output' && kind !== 'tool-input';
  if (!inline && row.blob_key !== null && row.admitted !== 1) return null;
  return row;
}

async function storedField(env: Pick<ServerEnv, 'blobs'>, row: ProcessedField): Promise<StoredObjectBody> {
  if (row.object_key === null) throw new Error('Processed body has no registered stored object');
  const object = await env.blobs.get(row.object_key);
  if (object === null) throw new Error('Processed body stored object is missing');
  return object;
}

/** A processed text field in its Project; an unclassified stored body is unavailable. */
export async function processedBody(env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, kind: ProcessedTextKind, id: string): Promise<string | null> {
  const row = await processedField(env, scope, kind, id);
  if (row === null) return null;
  if (row.text !== null && kind !== 'tool-output' && kind !== 'tool-input') return row.text;
  if (row.blob_key === null) return row.text;
  const object = await storedField(env, row);
  if (kind === 'tool-input' && row.text !== null) {
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (row.registered_size !== bytes.byteLength || object.size !== bytes.byteLength || await sha256HexOf(bytes) !== row.blob_key) {
      throw new Error('Processed tool input stored object does not match its registered body');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  return new Response(object.body).text();
}

/** An attachment's complete bytes, admitted by its logical row and stored-field provenance. */
export async function processedAttachment(env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, id: string): Promise<(StoredObjectBody & { mediaType: string }) | null> {
  const row = await processedField(env, scope, 'attachment', id);
  if (row === null) return null;
  const object = await storedField(env, row);
  return { body: object.body, size: object.size, mediaType: row.media_type ?? 'application/octet-stream' };
}
