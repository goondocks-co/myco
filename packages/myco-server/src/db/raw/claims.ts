/**
 * Raw ownership claims: who an unattributed raw resource belongs to once the Deployment owner claims a reviewed
 * snapshot, and the revision interval a restore reserves for the claims it carries.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { deploymentOwnerSql } from '../identity/ownership-policy.js';
import { commit, first, read, rows, write } from '../index.js';

/** A claim covers only missing provenance at its reviewed revision; recorded and contradictory identities are excluded. */
export const effectiveRawOwnerSql = (owner: string, provenance: string, revision: string, candidate = 'NULL'): string => `COALESCE(${owner},
  (SELECT rc.owner_member_id FROM raw_claims rc WHERE ${provenance} = 'missing' AND rc.min_revision <= ${revision} AND rc.cutoff_revision >= ${revision}
    AND (${candidate} IS NULL OR rc.owner_member_id = ${candidate})
    ORDER BY rc.cutoff_revision LIMIT 1))`;

/** A claim's reviewed revision fixes which ownership evidence its reader must consider. */
export const rawClaimCutoffSql = (owner: string, revision: string): string => `(SELECT rc.cutoff_revision FROM raw_claims rc
  WHERE rc.owner_member_id = ${owner} AND rc.min_revision <= ${revision} AND rc.cutoff_revision >= ${revision}
  ORDER BY rc.cutoff_revision LIMIT 1)`;

/** A missing raw identity admits only an unowned snapshot or its existing claimant. */
export const claimableRawIdentitySql = (project: string, kind: string, id: string, claimant = 'NULL', cutoff = 'NULL'): string => `NOT EXISTS (
  SELECT 1 FROM raw_resources other WHERE other.project_id = ${project} AND other.kind = ${kind}
    AND other.resource_id = ${id} AND (${cutoff} IS NULL OR other.revision <= ${cutoff}) AND (other.provenance <> 'missing'
      OR (other.claim_member_id IS NOT NULL AND other.claim_member_id IS NOT ${claimant === 'NULL' ? '(SELECT member_id FROM deployment_ownership WHERE id = 1)' : claimant})
      OR (${effectiveRawOwnerSql('other.owner_member_id', 'other.provenance', 'other.revision', 'other.claim_member_id')} IS NOT NULL
        AND ${effectiveRawOwnerSql('other.owner_member_id', 'other.provenance', 'other.revision', 'other.claim_member_id')} IS NOT ${claimant})))`;

const unknown = (owner: string, provenance: string, revision: string, candidate = 'NULL'): string => `${provenance} = 'missing' AND ${effectiveRawOwnerSql(owner, provenance, revision, candidate)} IS NULL`;

const state = read<[], { revision: number; complete: number }>({ name: 'raw.claimState', sql:
  'SELECT s.revision, b.complete FROM raw_provenance_state s JOIN raw_provenance_backfill b ON b.id = s.id WHERE s.id = 1' });

export interface UnclaimedRawCount { project_id: string; kind: 'blob' | 'event' | 'transcript'; count: number; oldest_at: number; newest_at: number }
const unclaimed = read<[], UnclaimedRawCount>({ name: 'raw.unclaimedCounts', sql:
  `SELECT project_id, kind, COUNT(*) AS count, MIN(at) AS oldest_at, MAX(at) AS newest_at FROM (
    SELECT b.project_id, 'blob' AS kind, b.received_at AS at FROM blobs b
      WHERE EXISTS (SELECT 1 FROM raw_resources r WHERE r.project_id = b.project_id AND r.kind = 'blob' AND r.resource_id = b.key
        AND ${unknown('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')})
      AND ${claimableRawIdentitySql('b.project_id', "'blob'", 'b.key')}
    UNION ALL SELECT t.project_id, 'transcript', t.first_received_at FROM transcripts t
      WHERE EXISTS (SELECT 1 FROM raw_resources r WHERE r.project_id = t.project_id AND r.kind = 'transcript'
        AND r.resource_id = t.transcript_id AND ${unknown('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')}) AND ${claimableRawIdentitySql('t.project_id', "'transcript'", 't.transcript_id')}
    UNION ALL SELECT e.project_id, 'event', e.received_at FROM events e JOIN raw_credentials c ON c.token_id = e.token_id
      WHERE ${unknown('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
    ) GROUP BY project_id, kind ORDER BY project_id, kind` });

const projectNames = read<[], { project_id: string; name: string }>({ name: 'raw.claimProjectNames', sql: 'SELECT project_id, name FROM projects ORDER BY project_id' });
const revision = read<[], { revision: number }>({ name: 'raw.provenanceRevision', sql: 'SELECT revision FROM raw_provenance_state WHERE id = 1' });

/** The provenance revision and whether the backfill has finished, or null before the state row exists. */
export const rawClaimState = (db: RelationalStore) => first(db, state.bind());
/** Unattributed raw resources a claim may cover, counted by Project and kind. */
export const unclaimedRawCounts = (db: RelationalStore) => rows(db, unclaimed.bind());
export const rawClaimProjectNames = (db: RelationalStore) => rows(db, projectNames.bind());
export const rawProvenanceRevision = async (db: RelationalStore): Promise<number | null> => (await first(db, revision.bind()))?.revision ?? null;

const claim = write<[id: string, owner: string, now: number, preview: string, revision: string], { id: string }>({ name: 'raw.recordClaim', sql:
  `INSERT INTO raw_claims (id,owner_member_id,cutoff_revision,created_at,preview)
    SELECT ?1, ?2, revision, ?3, ?4 FROM raw_provenance_state WHERE id = 1 AND revision = ?5 AND ${deploymentOwnerSql('?2')}
      AND EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND complete = 1)
    ON CONFLICT DO NOTHING RETURNING id` });

/** Records the claim only while `owner` owns the Deployment, the backfill is complete and the revision is still `revision`. */
export async function recordRawClaim(db: RelationalStore, input: { id: string; owner: string; now: number; preview: string; revision: string }): Promise<boolean> {
  return (await rows(db, claim.bind(input.id, input.owner, input.now, input.preview, input.revision))).length === 1;
}

const reserveRevision = write<[artifact: string, sourceRevision: number]>({ name: 'raw.reserveRestoreRevision', sql:
  `INSERT INTO raw_restore_revisions (artifact_hash,revision_offset,source_revision)
    SELECT ?1, revision + 1, ?2 FROM raw_provenance_state WHERE id = 1 ON CONFLICT DO NOTHING` });
const raiseRevision = write<[artifact: string]>({ name: 'raw.raiseRevisionPastRestore', sql:
  `UPDATE raw_provenance_state SET revision = MAX(revision,
    (SELECT revision_offset + source_revision + 1 FROM raw_restore_revisions WHERE artifact_hash = ?1)) WHERE id = 1` });
const restartBackfill = write<[]>({ name: 'raw.restartBackfill', sql:
  `UPDATE raw_provenance_backfill SET source = 0, cursor_project = '', cursor_id = '', complete = 0 WHERE id = 1` });

/** Reserves the artifact's revision interval once, moves the live revision past it and restarts the backfill, in one batch. */
export async function reserveRawRestoreRevisions(db: RelationalStore, artifactHash: string, sourceRevision: number): Promise<void> {
  await commit(db, reserveRevision.bind(artifactHash, sourceRevision), raiseRevision.bind(artifactHash), restartBackfill.bind());
}
