import { processed_processedField as processedField, type processed_ProcessedField as ProcessedField, type processed_ProcessedBodyKind as ProcessedBodyKind, type processed_ProcessedTextKind as ProcessedTextKind } from './catalog/processed.js';
import type { ServerEnv, StoredObjectBody } from '../core/adapters.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { sha256HexOf, utf8 } from '../hash.js';
import type { ReadScope } from './scope.js';

async function storedField(env: Pick<ServerEnv, 'blobs'>, row: ProcessedField): Promise<StoredObjectBody> {
  if (row.object_key === null) throw new Error('Processed body has no registered stored object');
  const object = await env.blobs.get(row.object_key);
  if (object === null) throw new Error('Processed body stored object is missing');
  return object;
}

/** A processed text field in its Project; an unclassified stored body is unavailable. */
export function processedBody(env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, kind: ProcessedTextKind, id: string): Promise<string | null> {
  return (db=>readProcessedBody({...env,db},scope,kind,id))(env.db);
}
async function readProcessedBody(env: Pick<ServerEnv, 'db' | 'blobs'>, scope: ReadScope, kind: ProcessedTextKind, id: string): Promise<string | null> {
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
