import type { RawClaimPreview, RawClaimOutcome, DeploymentOwnershipPreview } from '@goondocks/myco-shared/raw-claims';
import type { RelationalStore } from './adapters.js';

export class RawClaimRefusal extends Error {
  constructor(readonly code: 'not_owner' | 'not_admin' | 'owner_already_recorded' | 'invalid_owner' | 'revision_conflict' | 'backfill_pending') { super(code); }
}

export const deploymentOwnerSql = (member: string): string => `EXISTS (SELECT 1 FROM deployment_ownership o JOIN members m ON m.id = o.member_id
  WHERE o.id = 1 AND o.member_id = ${member} AND m.revoked_at IS NULL AND m.role = 'admin')`;
export async function isDeploymentOwner(db: RelationalStore, memberId: string): Promise<boolean> {
  return (await db.prepare(`SELECT ${deploymentOwnerSql('?')} AS admitted`).bind(memberId).first<{ admitted: number }>())?.admitted === 1;
}

export async function ownershipPreview(db: RelationalStore): Promise<DeploymentOwnershipPreview> {
  const row = await db.prepare('SELECT member_id, revision FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null; revision: number }>();
  if (row === null) throw new Error('Deployment ownership record is missing');
  return { ownerMemberId: row.member_id, revision: String(row.revision) };
}

/** Initial owner selection is explicit; the guarded write cannot replace an established owner. */
export async function bootstrapOwnership(db: RelationalStore, actor: string, candidate: string, revision: string, now: number): Promise<DeploymentOwnershipPreview> {
  const admin = await db.prepare("SELECT 1 AS admitted FROM members WHERE id = ? AND role = 'admin' AND revoked_at IS NULL").bind(actor).first();
  if (admin === null) throw new RawClaimRefusal('not_admin');
  const current = await ownershipPreview(db);
  if (current.ownerMemberId === candidate) return current;
  if (current.ownerMemberId !== null) throw new RawClaimRefusal('owner_already_recorded');
  if (current.revision !== revision) throw new RawClaimRefusal('revision_conflict');
  const live = await db.prepare("SELECT 1 AS admitted FROM members WHERE id = ? AND role = 'admin' AND github_id IS NOT NULL AND revoked_at IS NULL")
    .bind(candidate).first();
  if (live === null) throw new RawClaimRefusal('invalid_owner');
  const results = await db.batch([
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = revision + 1 WHERE id = 1 AND member_id IS NULL AND revision = ?
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'admin' AND revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND role = 'admin' AND github_id IS NOT NULL AND revoked_at IS NULL)`)
      .bind(candidate, revision, actor, candidate),
    db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at)
      SELECT revision, member_id, ?, ? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ?
      ON CONFLICT DO NOTHING`).bind(actor, now, candidate, Number(revision) + 1),
  ]);
  if (results[0]!.meta.changes === 0) throw new RawClaimRefusal('revision_conflict');
  return ownershipPreview(db);
}

/** A claim covers only missing provenance at its reviewed revision; recorded and contradictory identities are excluded. */
export const effectiveRawOwnerSql = (owner: string, provenance: string, revision: string, candidate = 'NULL'): string => `COALESCE(${owner},
  (SELECT rc.owner_member_id FROM raw_claims rc WHERE ${provenance} = 'missing' AND rc.min_revision <= ${revision} AND rc.cutoff_revision >= ${revision}
    AND (${candidate} IS NULL OR rc.owner_member_id = ${candidate})
    ORDER BY rc.cutoff_revision LIMIT 1))`;

/** A missing raw identity admits only an unowned snapshot or its existing claimant. */
export const claimableRawIdentitySql = (project: string, kind: string, id: string, claimant = 'NULL'): string => `NOT EXISTS (
  SELECT 1 FROM raw_resources other WHERE other.project_id = ${project} AND other.kind = ${kind}
    AND other.resource_id = ${id} AND (other.provenance <> 'missing'
      OR (other.claim_member_id IS NOT NULL AND other.claim_member_id IS NOT ${claimant === 'NULL' ? '(SELECT member_id FROM deployment_ownership WHERE id = 1)' : claimant})
      OR (${effectiveRawOwnerSql('other.owner_member_id', 'other.provenance', 'other.revision', 'other.claim_member_id')} IS NOT NULL
        AND ${effectiveRawOwnerSql('other.owner_member_id', 'other.provenance', 'other.revision', 'other.claim_member_id')} IS NOT ${claimant})))`;

const unknown = (owner: string, provenance: string, revision: string, candidate = 'NULL'): string => `${provenance} = 'missing' AND ${effectiveRawOwnerSql(owner, provenance, revision, candidate)} IS NULL`;

export async function rawClaimPreview(db: RelationalStore, actor: string): Promise<RawClaimPreview> {
  if (!await isDeploymentOwner(db, actor)) throw new RawClaimRefusal('not_owner');
  const state = await db.prepare(`SELECT s.revision, b.complete FROM raw_provenance_state s JOIN raw_provenance_backfill b ON b.id = s.id WHERE s.id = 1`)
    .first<{ revision: number; complete: number }>();
  if (state === null) throw new Error('Raw provenance state is missing');
  const rows = (await db.prepare(`SELECT project_id, kind, COUNT(*) AS count, MIN(at) AS oldest_at, MAX(at) AS newest_at FROM (
    SELECT b.project_id, 'blob' AS kind, b.received_at AS at FROM blobs b
      WHERE EXISTS (SELECT 1 FROM raw_resources r WHERE r.project_id = b.project_id AND r.kind = 'blob' AND r.resource_id = b.key
        AND ${unknown('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')})
      AND ${claimableRawIdentitySql('b.project_id', "'blob'", 'b.key')}
    UNION ALL SELECT t.project_id, 'transcript', t.first_received_at FROM transcripts t
      WHERE EXISTS (SELECT 1 FROM raw_resources r WHERE r.project_id = t.project_id AND r.kind = 'transcript'
        AND r.resource_id = t.transcript_id AND ${unknown('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')}) AND ${claimableRawIdentitySql('t.project_id', "'transcript'", 't.transcript_id')}
    UNION ALL SELECT e.project_id, 'event', e.received_at FROM events e JOIN raw_credentials c ON c.token_id = e.token_id
      WHERE ${unknown('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
    ) GROUP BY project_id, kind ORDER BY project_id, kind`).all<{ project_id: string; kind: 'blob' | 'event' | 'transcript'; count: number; oldest_at: number; newest_at: number }>()).results;
  const names = (await db.prepare('SELECT project_id, name FROM projects ORDER BY project_id').all<{ project_id: string; name: string }>()).results;
  // The revision after the aggregate must still be the revision it describes.
  const latest = await db.prepare('SELECT revision FROM raw_provenance_state WHERE id = 1').first<{ revision: number }>();
  if (latest?.revision !== state.revision) throw new RawClaimRefusal('revision_conflict');
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
  const result = await db.prepare(`INSERT INTO raw_claims (id,owner_member_id,cutoff_revision,created_at,preview)
    SELECT ?, ?, revision, ?, ? FROM raw_provenance_state WHERE id = 1 AND revision = ? AND ${deploymentOwnerSql('?')}
      AND EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND complete = 1)
    ON CONFLICT DO NOTHING`).bind(id, actor, now, JSON.stringify(preview), revision, actor).run();
  if (result.meta.changes === 0) throw new RawClaimRefusal('revision_conflict');
  return { claimId: id, preview: await rawClaimPreview(db, actor) };
}

/** Imported claim ranges occupy a reserved revision interval, disjoint from destination capture and later uploads. */
export async function reserveRawRestore(db: RelationalStore, artifactHash: string, sourceRevision: number): Promise<number> {
  await db.batch([
    db.prepare(`INSERT INTO raw_restore_revisions (artifact_hash,revision_offset,source_revision)
      SELECT ?, revision + 1, ? FROM raw_provenance_state WHERE id = 1 ON CONFLICT DO NOTHING`).bind(artifactHash, sourceRevision),
    db.prepare(`UPDATE raw_provenance_state SET revision = MAX(revision,
      (SELECT revision_offset + source_revision + 1 FROM raw_restore_revisions WHERE artifact_hash = ?)) WHERE id = 1`).bind(artifactHash),
    db.prepare(`UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0 WHERE id = 1`),
  ]);
  const held = await db.prepare('SELECT revision_offset FROM raw_restore_revisions WHERE artifact_hash = ?').bind(artifactHash).first<{ revision_offset: number }>();
  if (held === null) throw new Error('Raw restore revision reservation is missing');
  return held.revision_offset;
}

/** Recovery can fill an unselected owner; additive restore preserves an established destination owner. */
export async function restoreOwnership(db: RelationalStore, row: { member_id: string; revision: number }, audit: { actor_id: string; created_at: number }): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE deployment_ownership SET member_id = ?, revision = ? WHERE id = 1 AND member_id IS NULL`)
      .bind(row.member_id, row.revision),
    db.prepare(`INSERT INTO deployment_ownership_audit (revision,member_id,actor_id,created_at)
      SELECT revision,member_id,?,? FROM deployment_ownership WHERE id = 1 AND member_id = ? AND revision = ? ON CONFLICT DO NOTHING`)
      .bind(audit.actor_id, audit.created_at, row.member_id, row.revision),
  ]);
}
