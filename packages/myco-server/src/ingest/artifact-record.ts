import type { ServerEnv } from '../core/adapters.js';
import { readVerifiedContentText } from '../core/registered-content.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { readBundleEntry } from '../core/archive-bundle.js';
import { materialRecord } from '../content/document-records.js';
import type { DocRecord } from '../content/document.js';

const BODIES = {
  prompt: [['blob_key', 'text']],
  reply: [['blob_key', 'text']],
  tool: [['input_blob_key', 'input']],
} as const;

/** A legacy artifact record retains its canonical id and its complete verified body. */
export async function legacyRecord(env: Pick<ServerEnv, 'db' | 'blobs'>, projectId: string, kind: keyof typeof BODIES,
  row: Record<string, unknown>): Promise<DocRecord> {
  const complete = {...row};
  for (const [column, field] of BODIES[kind]) {
    const key = row[column];
    if (typeof key !== 'string') continue;
    const blob = await env.db.prepare(`SELECT generation,size FROM blobs WHERE project_id=? AND key=?`)
      .bind(projectId,key).first<{generation:string|null;size:number}>();
    if (blob === null) throw new Error('artifact_body_missing');
    complete[field] = await readVerifiedContentText(env,blobObjectKey(projectId,key,blob.generation),blob.size,key);
  }
  if (kind === 'tool' && typeof row.input_bundle_id === 'number' && typeof row.input_blob_key !== 'string') {
    complete.input = await readBundleEntry(env,{projectId,bundleId:row.input_bundle_id,entry:Number(row.input_bundle_entry),
      kind:'tool-input',resourceId:String(row.tool_call_id),tokenId:String(row.token_id)});
  }
  if (kind !== 'tool' && typeof complete.text !== 'string') throw new Error('artifact_body_missing');
  return materialRecord(kind,complete);
}
