import type { D1Like } from '../env.js';
import type { ReadScope } from './scope.js';

export interface BlobRow {
  size: number;
  mediaType: string;
}

/** A stored blob's record inside the scope, or null. Blobs are keyed `(project_id, key)`, so the scope is part of the lookup rather than a filter applied afterwards. */
export async function getBlob(db: D1Like, scope: ReadScope, key: string): Promise<BlobRow | null> {
  const row = await db
    .prepare(`SELECT size, media_type FROM blobs WHERE project_id = ? AND key = ?`)
    .bind(scope.projectId, key)
    .first<{ size: number; media_type: string }>();
  return row === null ? null : { size: row.size, mediaType: row.media_type };
}
