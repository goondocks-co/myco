import { claimableRawIdentitySql, effectiveRawOwnerSql, rawClaimCutoffSql } from './raw-claims.js';
import type { ServerEnv } from './adapters.js';
import { getBlob, type BlobRow } from '../read/blobs.js';
import { clampLimit, encodeCursor, inListChunks, type ReadScope } from '../read/scope.js';
import { listTranscripts, pageSegments, type TranscriptRow, type SegmentRow } from '../read/transcript.js';
import { authorize, memberSubject } from '../auth/authorization.js';
import { eventContent } from './event-content.js';
import { bundleContentEnv } from './archive-bundle.js';

const RAW_TRANSCRIPT_PAGE = 10;

export type RawResource = { kind: 'blob' | 'event' | 'transcript'; id: string };
export type RawAction = 'enumerate' | 'read';
export type RawSubject = { kind: 'member'; memberId: string } | { kind: 'run' | 'grant'; id: string };

/** Raw responses require authentication again on every request, including cached browser navigations. */
export const RAW_CACHE_HEADERS = { 'cache-control': 'private, no-store', vary: 'Cookie, Authorization' } as const;

/** The uploader rule used by raw reads and member admission of uploaded references. */
export const rawMemberResourceSql = (project: string, kind: RawResource['kind'], id: string, member: string): string =>
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

/** User raw reads are admitted by historical upload evidence and the requester's current membership. */
export class RawResourceReader {
  private identity: ReturnType<typeof memberSubject> | undefined;
  private readonly contentEnv: Pick<ServerEnv, 'db' | 'blobs'>;
  constructor(
    private readonly env: Pick<ServerEnv, 'db' | 'blobs'>,
    private readonly scope: ReadScope,
    private readonly subject: RawSubject,
  ) {
    this.contentEnv = bundleContentEnv(env);
  }

  async allows(resource: RawResource, action: RawAction): Promise<boolean> {
    if (this.subject.kind !== 'member' || (action !== 'read' && action !== 'enumerate')) return false;
    const row = await this.env.db
      .prepare(`SELECT ${rawMemberResourceSql('?', resource.kind, '?', '?')} AS admitted`)
      .bind(this.scope.projectId, resource.id, this.subject.memberId)
      .first<{ admitted: number }>();
    const subject = await (this.identity ??= memberSubject(this.env.db, this.subject.memberId, 'http'));
    return authorize(subject, action === 'enumerate' ? 'enumerate' : 'read', {
      kind: 'raw',
      exists: true,
      deploymentId: subject.deploymentId,
      projectId: this.scope.projectId,
      id: resource.id,
      uploader: row?.admitted === 1,
    });
  }

  async blob(key: string): Promise<{ row: BlobRow; body: ReadableStream<Uint8Array> } | null> {
    if (!(await this.allows({ kind: 'blob', id: key }, 'read'))) return null;
    const row = await getBlob(this.env.db, this.scope, key);
    if (row === null) return null;
    const object = await this.env.blobs.get(row.objectKey);
    return object === null ? null : { row, body: object.body };
  }

  async event(eventId: string): Promise<string | null> {
    if (!(await this.allows({ kind: 'event', id: eventId }, 'read'))) return null;
    return eventContent(this.contentEnv, this.scope.projectId, eventId);
  }

  /** One batch retains the same item proof as individual reads and the request's resolved membership. */
  private async admitted(kind: RawResource['kind'], ids: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (this.subject.kind !== 'member') return found;
    const subject = await (this.identity ??= memberSubject(this.env.db, this.subject.memberId, 'http'));
    if (
      !authorize(subject, 'enumerate', {
        kind: 'raw',
        exists: true,
        deploymentId: subject.deploymentId,
        projectId: this.scope.projectId,
        uploader: true,
      })
    )
      return found;
    for (const keys of inListChunks(ids)) {
      const rows = await this.env.db
        .prepare(
          `SELECT q.value AS id FROM json_each(?) q
        WHERE ${rawMemberResourceSql('?', kind, 'q.value', '?')}`,
        )
        .bind(JSON.stringify(keys), this.scope.projectId, this.subject.memberId)
        .all<{ id: string }>();
      for (const row of rows.results) found.add(row.id);
    }
    return found;
  }

  async transcripts(
    sessionId: string,
    opts: { limit?: number; cursor?: string; transcriptId?: string; segmentCursor?: string } = {},
  ): Promise<RawTranscriptPage> {
    const limit = Math.min(clampLimit(opts.limit), RAW_TRANSCRIPT_PAGE);
    const rows = await listTranscripts(this.env.db, this.scope, sessionId, { after: opts.cursor, limit, transcriptId: opts.transcriptId });
    const visible = rows.slice(0, limit),
      owned = await this.admitted(
        'transcript',
        visible.map((row) => row.transcriptId),
      );
    const transcripts: RawTranscript[] = [];
    for (const transcript of visible) {
      if (!owned.has(transcript.transcriptId)) continue;
      const held = await pageSegments(this.env.db, this.scope, transcript.transcriptId, { limit: opts.limit, cursor: opts.segmentCursor });
      const blobs = await this.admitted(
        'blob',
        held.rows.map((row) => row.blobKey),
      );
      transcripts.push({ ...transcript, segments: held.rows.filter((row) => blobs.has(row.blobKey)), segmentsCursor: held.cursor });
    }
    return {
      transcripts,
      cursor: rows.length > limit ? encodeCursor(visible.at(-1)!.role === 'subagent' ? 1 : 0, visible.at(-1)!.transcriptId) : null,
    };
  }
}

export type RawTranscript = TranscriptRow & { segments: readonly SegmentRow[]; segmentsCursor: string | null };
export interface RawTranscriptPage {
  transcripts: RawTranscript[];
  cursor: string | null;
}
