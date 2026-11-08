import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { BlobRef } from '@myco-server-worker/core/blob-references.js';
import { recordBlobCandidates, releaseBlobs, type ReleaseOutcome } from '@myco-server-worker/core/object-release.js';

/** What every deletion does: records the candidates in a batch of their own here, then decides them. */
export async function releaseNow(db: RelationalStore, pairs: readonly BlobRef[], now: number): Promise<ReleaseOutcome> {
  if (pairs.length > 0) await db.batch(recordBlobCandidates(db, pairs, now, { callerHoldsReference: true }));
  return releaseBlobs(db, pairs, now);
}
