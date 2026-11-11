import type { RelationalStore } from '../../core/adapters.js';
import { claimableRawIdentitySql, effectiveRawOwnerSql, rawClaimCutoffSql } from './claims.js';
import { BLOB_REFERENCES, blobReferenceColumn, kindFilter, type BlobReference } from '../../core/blob-references.js';
import { read, rows, type Statement } from '../index.js';
import { notTombstonedSql } from '../session-read-model.js';
import { blobHeld } from '../storage/blob-held.js';

/** A raw resource kind: what a member may read back of what they uploaded. */
export type RawKind = 'blob' | 'event' | 'transcript';

/** The uploader rule used by raw reads and member admission of uploaded references. */
export const rawMemberResourceSql = (project: string, kind: RawKind, id: string, member: string): string =>
  kind === 'event'
    ? `EXISTS (SELECT 1 FROM events e JOIN raw_credentials c ON c.token_id = e.token_id
      JOIN members m ON m.id = ${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
      WHERE e.project_id = ${project} AND e.event_id = ${id} AND m.id = ${member} AND m.revoked_at IS NULL
        AND (e.raw_revision > 0 OR EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND complete = 1)))`
    : `EXISTS (SELECT 1 FROM raw_resources r JOIN members m ON m.id = ${effectiveRawOwnerSql('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')}
      WHERE r.project_id = ${project} AND r.kind = '${kind}' AND r.resource_id = ${id} AND r.classification = 'raw'
        AND NOT EXISTS (SELECT 1 FROM archive_bundles a WHERE '${kind}'='blob' AND a.project_id=r.project_id
          AND a.archive_key=r.resource_id)
        AND NOT EXISTS (SELECT 1 FROM archive_bundles a WHERE '${kind}'='blob' AND a.project_id=r.project_id
          AND a.receipt_key=r.resource_id)
        AND NOT EXISTS (SELECT 1 FROM registered_content_proofs p INDEXED BY idx_registered_content_proofs_key WHERE '${kind}'='blob' AND p.project_id=r.project_id
          AND p.key=r.resource_id AND (p.source_kind='bundle' OR (p.source_kind='receipt' AND p.source_id LIKE 'bundle:%')))
        AND m.id = ${member} AND m.revoked_at IS NULL
        AND (r.provenance <> 'missing' OR ${claimableRawIdentitySql('r.project_id', 'r.kind', 'r.resource_id', 'm.id', rawClaimCutoffSql('m.id', 'r.revision'))}))`;


/** A resource of a deleted session is no longer anyone's to read, from the moment its tombstone commits. */
const deletedSession = (kind: RawKind, id: string): string => kind === 'event'
  ? `EXISTS(SELECT 1 FROM events z JOIN session_tombstones t ON t.project_id=z.project_id AND t.session_id=z.session_id WHERE z.project_id=?1 AND z.event_id=${id})`
  : kind === 'transcript'
    ? `EXISTS(SELECT 1 FROM transcripts z JOIN session_tombstones t ON t.project_id=z.project_id AND t.session_id=z.session_id WHERE z.project_id=?1 AND z.transcript_id=${id})`
    : '0';

const KINDS: readonly RawKind[] = ['blob', 'event', 'transcript'];
const one = (kind: RawKind) => read<[project: string, id: string, member: string], { admitted: number }>({ name: `raw.admitted${kind[0]!.toUpperCase()}${kind.slice(1)}`, sql:
  `SELECT ${rawMemberResourceSql('?1', kind, '?2', '?3')} AND NOT ${deletedSession(kind, '?2')} AS admitted` });
const many = (kind: RawKind) => read<[project: string, ids: string, member: string], { id: string }>({ name: `raw.admittedAmong${kind[0]!.toUpperCase()}${kind.slice(1)}`, sql:
  `SELECT q.value AS id FROM json_each(?2) q WHERE ${rawMemberResourceSql('?1', kind, 'q.value', '?3')} AND NOT ${deletedSession(kind, 'q.value')}` });

const ONE: Record<RawKind, Statement<[string, string, string], { admitted: number }, 'read'>> = Object.fromEntries(KINDS.map(kind => [kind, one(kind)])) as never;
const MANY: Record<RawKind, Statement<[string, string, string], { id: string }, 'read'>> = Object.fromEntries(KINDS.map(kind => [kind, many(kind)])) as never;

/** Whether the member's upload evidence admits them to this raw resource. */
export async function memberAdmitted(db: RelationalStore, project: string, kind: RawKind, id: string, member: string): Promise<boolean> {
  const [row] = await rows(db, ONE[kind].bind(project, id, member));
  return row?.admitted === 1;
}

/** Which of these resources the member's upload evidence admits them to. */
export async function membersAdmittedAmong(db: RelationalStore, project: string, kind: RawKind, ids: readonly string[], member: string): Promise<string[]> {
  return (await rows(db, MANY[kind].bind(project, JSON.stringify(ids), member))).map(row => row.id);
}

/** True while a row of `ref` that does not belong to a deleted session names the blob. */
const liveReference = (ref: BlobReference): string => {
  const column = blobReferenceColumn(ref, 'r');
  if (ref.table === 'run_bodies') return `EXISTS(SELECT 1 FROM run_bodies r WHERE r.project_id=?1 AND ${column}=?2)`;
  if (ref.table === 'transcript_segments') return `EXISTS(SELECT 1 FROM transcript_segments r JOIN transcripts x ON x.project_id=r.project_id AND x.transcript_id=r.transcript_id
    WHERE r.project_id=?1 AND ${column}=?2 AND ${notTombstonedSql('x')})`;
  return `EXISTS(SELECT 1 FROM ${ref.table} r WHERE r.project_id=?1 AND ${column}=?2${kindFilter(ref).replace(' kind ', ' r.kind ')} AND ${notTombstonedSql('r')})`;
};

const onlyDeletedSessions = read<[project: string, key: string], { hidden: number }>({ name: 'raw.blobOnlyInDeletedSessions', sql:
  `SELECT NOT (${BLOB_REFERENCES.map(liveReference).join(' OR ')})
    AND (${blobHeld('?1', '?2')} OR EXISTS(SELECT 1 FROM blob_release_candidates c WHERE c.project_id=?1 AND c.key=?2)) AS hidden` });

/**
 * Whether a blob's only remaining claim is a deleted session: every row naming it belongs to one, or none is left and its
 * release is pending. A blob another live row names, or that no deletion ever touched, stays readable by its uploader.
 */
export async function blobOnlyInDeletedSessions(db: RelationalStore, project: string, key: string): Promise<boolean> {
  const [row] = await rows(db, onlyDeletedSessions.bind(project, key));
  return row?.hidden === 1;
}
