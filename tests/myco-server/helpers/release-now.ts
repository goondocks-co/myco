import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { BlobRef } from '@myco-server-worker/core/blob-references.js';
import { recordObservedCandidates, releaseBlobs, type ReleaseOutcome } from '@myco-server-worker/core/object-release.js';

/** Candidates for `pairs` as a caller that has just read their references records them: each with the generation registered now. */
export async function recordCurrent(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<PreparedStatement[]> {
  const observed = await Promise.all(pairs.map(async pair => ({ ...pair,
    generation: (await db.prepare('SELECT generation FROM blobs WHERE project_id=? AND key=?').bind(pair.projectId, pair.key).first<{ generation: string | null }>())?.generation ?? null })));
  return recordObservedCandidates(db, observed, now);
}

/** What every deletion does: records the candidates in a batch of their own here, then decides them. */
export async function releaseNow(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<ReleaseOutcome> {
  if (pairs.length > 0) await db.batch(await recordCurrent(db, pairs, now));
  return releaseBlobs(db, pairs, now);
}
