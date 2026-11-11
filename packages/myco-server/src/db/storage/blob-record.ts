import type { RelationalStore } from '../../core/adapters.js';
import { blobObjectKeySql } from '../../core/blob-objects.js';
import { read, readSet } from '../index.js';

export interface BlobRecord { size: number; media_type: string; object_key: string }

const record = read<[project: string, key: string], BlobRecord>({ name: 'storage.blobRecord', sql:
  `SELECT size, media_type, ${blobObjectKeySql('project_id', 'key', 'generation')} AS object_key FROM blobs WHERE project_id = ?1 AND key = ?2` });

/** The stored blob `key` of a Project registers, with the object key its bytes live under, or null. */
export async function blobRecord(db: RelationalStore, project: string, key: string): Promise<BlobRecord | null> {
  const [[row]] = await readSet(db, record.bind(project, key));
  return row ?? null;
}
