import { blobObjectKeySql } from '../core/blob-objects.js';
import type { RelationalStore } from '../core/adapters.js';
import type { ReadScope } from './scope.js';

export interface BlobRow {
  size: number;
  mediaType: string;
  /** The stored object this row registered (`core/blob-objects.ts`). */
  objectKey: string;
}

/** A stored blob's record inside the scope, or null. Blobs are keyed `(project_id, key)`, so the scope is part of the lookup rather than a filter applied afterwards. */
export async function getBlob(db: RelationalStore, scope: ReadScope, key: string): Promise<BlobRow | null> {
  const row = await db
    .prepare(`SELECT size, media_type, ${blobObjectKeySql('project_id', 'key', 'generation')} AS object_key FROM blobs WHERE project_id = ? AND key = ?`)
    .bind(scope.projectId, key)
    .first<{ size: number; media_type: string; object_key: string }>();
  return row === null ? null : { size: row.size, mediaType: row.media_type, objectKey: row.object_key };
}
