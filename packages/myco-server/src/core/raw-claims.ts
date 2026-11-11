import type { RawClaimPreview, RawClaimOutcome } from '@goondocks/myco-shared/raw-claims';
import type { RelationalStore } from './adapters.js';

import { isDeploymentOwner, OwnershipRefusal as RawClaimRefusal } from '../db/identity/ownership.js';
import { rawClaimProjectNames, rawClaimState, rawProvenanceRevision, recordRawClaim, reserveRawRestoreRevisions, unclaimedRawCounts } from '../db/raw/claims.js';
import { reservedRestoreOffset } from '../db/raw/restore-revisions.js';

export async function rawClaimPreview(db: RelationalStore, actor: string): Promise<RawClaimPreview> {
  if (!await isDeploymentOwner(db, actor)) throw new RawClaimRefusal('not_owner');
  const state = await rawClaimState(db);
  if (state === null) throw new Error('Raw provenance state is missing');
  const rows = await unclaimedRawCounts(db);
  const names = await rawClaimProjectNames(db);
  // The revision after the aggregate must still be the revision it describes.
  if (await rawProvenanceRevision(db) !== state.revision) throw new RawClaimRefusal('revision_conflict');
  return { revision: String(state.revision), complete: state.complete === 1,
    projects: names.map((p) => ({ projectId: p.project_id, name: p.name, kinds: rows.filter((r) => r.project_id === p.project_id)
      .map((r) => ({ kind: r.kind, count: r.count, oldestAt: r.oldest_at, newestAt: r.newest_at })) })).filter((p) => p.kinds.length > 0) };
}

/** One immutable claim receipt attributes a reviewed snapshot, independently of its resource count. */
export async function claimUnknownRaw(db: RelationalStore, actor: string, revision: string, now: number): Promise<RawClaimOutcome> {
  const preview = await rawClaimPreview(db, actor);
  if (!preview.complete) throw new RawClaimRefusal('backfill_pending');
  if (preview.projects.length === 0) return { claimId: null, preview };
  if (revision !== preview.revision) throw new RawClaimRefusal('revision_conflict');
  const id = crypto.randomUUID();
  if (!await recordRawClaim(db, { id, owner: actor, now, preview: JSON.stringify(preview), revision })) throw new RawClaimRefusal('revision_conflict');
  return { claimId: id, preview: await rawClaimPreview(db, actor) };
}

/** Imported claim ranges occupy a reserved revision interval, disjoint from destination capture and later uploads. */
export async function reserveRawRestore(db: RelationalStore, artifactHash: string, sourceRevision: number): Promise<number> {
  await reserveRawRestoreRevisions(db, artifactHash, sourceRevision);
  const held = await reservedRestoreOffset(db, artifactHash);
  if (held === null) throw new Error('Raw restore revision reservation is missing');
  return held;
}
