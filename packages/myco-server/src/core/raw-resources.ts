import { claimableRawIdentitySql, effectiveRawOwnerSql, rawClaimCutoffSql } from './raw-claims.js';
import type { ServerEnv } from './adapters.js';
import { getBlob, type BlobRow } from '../read/blobs.js';
import type { ReadScope } from '../read/scope.js';
import { listTranscripts, listSegments, type TranscriptRow, type SegmentRow } from '../read/transcript.js';
import { authorize, deploymentIdentity, memberSubject } from '../auth/authorization.js';

export type RawResource = { kind: 'blob' | 'event' | 'transcript'; id: string };
export type RawAction = 'enumerate' | 'read';
export type RawSubject = { kind: 'member'; memberId: string } | { kind: 'run' | 'grant'; id: string };

/** Raw responses require authentication again on every request, including cached browser navigations. */
export const RAW_CACHE_HEADERS = { 'cache-control': 'private, no-store', vary: 'Cookie, Authorization' } as const;

/** The uploader rule used by raw reads and member admission of uploaded references. */
export const rawMemberResourceSql = (project: string, kind: RawResource['kind'], id: string, member: string): string => kind === 'event'
  ? `EXISTS (SELECT 1 FROM events e JOIN raw_credentials c ON c.token_id = e.token_id
      JOIN members m ON m.id = ${effectiveRawOwnerSql('c.owner_member_id', 'c.provenance', 'e.raw_revision')}
      WHERE e.project_id = ${project} AND e.event_id = ${id} AND m.id = ${member} AND m.revoked_at IS NULL
        AND (e.raw_revision > 0 OR EXISTS (SELECT 1 FROM raw_provenance_backfill WHERE id = 1 AND complete = 1)))`
  : `EXISTS (SELECT 1 FROM raw_resources r JOIN members m ON m.id = ${effectiveRawOwnerSql('r.owner_member_id', 'r.provenance', 'r.revision', 'r.claim_member_id')}
      WHERE r.project_id = ${project} AND r.kind = '${kind}' AND r.resource_id = ${id} AND r.classification = 'raw'
        AND m.id = ${member} AND m.revoked_at IS NULL
        AND (r.provenance <> 'missing' OR ${claimableRawIdentitySql('r.project_id', 'r.kind', 'r.resource_id', 'm.id', rawClaimCutoffSql('m.id', 'r.revision'))}))`;

/** User raw reads are admitted by historical upload evidence and the requester's current membership. */
export class RawResourceReader {
  constructor(private readonly env: Pick<ServerEnv, 'db' | 'blobs'>, private readonly scope: ReadScope, private readonly subject: RawSubject) {}

  async allows(resource: RawResource, action: RawAction): Promise<boolean> {
    if (this.subject.kind !== 'member' || (action !== 'read' && action !== 'enumerate')) return false;
    const row = await this.env.db.prepare(`SELECT ${rawMemberResourceSql('?', resource.kind, '?', '?')} AS admitted`)
      .bind(this.scope.projectId, resource.id, this.subject.memberId).first<{ admitted: number }>();
    const subject = await memberSubject(this.env.db, this.subject.memberId, 'http');
    return authorize(subject, 'read', { kind: 'raw', exists: true, deploymentId: await deploymentIdentity(this.env.db), projectId: this.scope.projectId, id: resource.id, uploader: row?.admitted === 1 });
  }

  async blob(key: string): Promise<{ row: BlobRow; body: ReadableStream<Uint8Array> } | null> {
    if (!await this.allows({ kind: 'blob', id: key }, 'read')) return null;
    const row = await getBlob(this.env.db, this.scope, key);
    if (row === null) return null;
    const object = await this.env.blobs.get(row.objectKey);
    return object === null ? null : { row, body: object.body };
  }

  async event(eventId: string): Promise<string | null> {
    if (!await this.allows({ kind: 'event', id: eventId }, 'read')) return null;
    const row = await this.env.db.prepare('SELECT payload FROM events WHERE project_id = ? AND event_id = ?')
      .bind(this.scope.projectId, eventId).first<{ payload: string }>();
    return row?.payload ?? null;
  }

  async transcripts(sessionId: string): Promise<(TranscriptRow & { segments: SegmentRow[] })[]> {
    const rows = await listTranscripts(this.env.db, this.scope, sessionId);
    const admitted: (TranscriptRow & { segments: SegmentRow[] })[] = [];
    for (const transcript of rows) {
      if (!await this.allows({ kind: 'transcript', id: transcript.transcriptId }, 'enumerate')) continue;
      const segments: SegmentRow[] = [];
      for (const segment of await listSegments(this.env.db, this.scope, transcript.transcriptId)) {
        if (await this.allows({ kind: 'blob', id: segment.blobKey }, 'enumerate')) segments.push(segment);
      }
      admitted.push({ ...transcript, segments });
    }
    return admitted;
  }
}
