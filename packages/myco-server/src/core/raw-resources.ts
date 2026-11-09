import { blobOnlyInDeletedSessions, memberAdmitted, membersAdmittedAmong, type RawKind } from '../db/raw/resources.js';
import type { ServerEnv } from './adapters.js';
import { getBlob, type BlobRow } from '../read/blobs.js';
import { clampLimit, inListChunks, type ReadScope } from '../read/scope.js';
import { listTranscripts, pageSegmentsAcross, transcriptCursor, type TranscriptRow, type SegmentRow } from '../read/transcript.js';
import { authorize, memberSubject } from '../auth/authorization.js';
import { eventContent } from './event-content.js';
import { bundleContentEnv } from './archive-bundle.js';

const RAW_TRANSCRIPT_PAGE = 10;

export type RawResource = { kind: RawKind; id: string };
export type RawAction = 'enumerate' | 'read';
type RawSubject = { kind: 'member'; memberId: string } | { kind: 'run' | 'grant'; id: string };

/** Raw responses require authentication again on every request, including cached browser navigations. */
export const RAW_CACHE_HEADERS = { 'cache-control': 'private, no-store', vary: 'Cookie, Authorization' } as const;

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
    const uploader = await memberAdmitted(this.env.db, this.scope.projectId, resource.kind, resource.id, this.subject.memberId);
    const subject = await (this.identity ??= memberSubject(this.env.db, this.subject.memberId, 'http'));
    return authorize(subject, action === 'enumerate' ? 'enumerate' : 'read', {
      kind: 'raw',
      exists: true,
      deploymentId: subject.deploymentId,
      projectId: this.scope.projectId,
      id: resource.id,
      uploader,
    });
  }

  async blob(key: string): Promise<{ row: BlobRow; body: ReadableStream<Uint8Array> } | null> {
    if (!(await this.allows({ kind: 'blob', id: key }, 'read'))) return null;
    if (await blobOnlyInDeletedSessions(this.env.db, this.scope.projectId, key)) return null;
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
      for (const id of await membersAdmittedAmong(this.env.db, this.scope.projectId, kind, keys, this.subject.memberId)) found.add(id);
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
    const readable = visible.filter(row => owned.has(row.transcriptId));
    const held = await pageSegmentsAcross(this.env.db, this.scope, readable.map(row => row.transcriptId), { limit: opts.limit, cursor: opts.segmentCursor });
    const blobs = await this.admitted('blob', held.flatMap(segments => segments.rows.map(row => row.blobKey)));
    const transcripts: RawTranscript[] = readable.map((transcript, index) => ({
      ...transcript, segments: held[index]!.rows.filter(row => blobs.has(row.blobKey)), segmentsCursor: held[index]!.cursor,
    }));
    return {
      transcripts,
      cursor: rows.length > limit ? transcriptCursor(visible.at(-1)!) : null,
    };
  }
}

type RawTranscript = TranscriptRow & { segments: readonly SegmentRow[]; segmentsCursor: string | null };
interface RawTranscriptPage {
  transcripts: RawTranscript[];
  cursor: string | null;
}
