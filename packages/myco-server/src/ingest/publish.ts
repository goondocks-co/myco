/**
 * The session document publisher.
 *
 * It keeps its own progress and shares none with the other transcript writers: a `transcript_publication` row per
 * transcript holds its offset and identity policy, the session's last page chunk holds each transcript's parser
 * continuation, and `publish_queue` holds the member events not yet published. A due session is read from those
 * frontiers, parsed with the common parser under the recorded policy, merged with its queued events, and written as
 * new chunk versions that one guarded batch makes live together with the catalog rows that describe them.
 *
 * A session is due when its `session_documents.due_at` has passed: a transcript grew, a member event joined its queue,
 * or an unfinished turn may now close. Only that row decides it; the queue and the documents are read only by a pass.
 *
 * Every chunk version a pass writes is held by a `retired_objects` row from before it is registered until the commit
 * that adopts it removes that row, and its proof is registered only while that row stands. A version whose pass never
 * committed is therefore released like a superseded one: its row, past its grace or when its own pass gives up, takes
 * its proofs with it, unless a live `session_chunks` row names its source.
 */
import type { ContentStore, PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion, readVerifiedContentText } from '../core/registered-content.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { bundleContentEnv } from '../core/archive-bundle.js';
import { eventContent } from '../core/event-content.js';
import { emit } from '../telemetry.js';
import { type DocRecord } from '../content/document.js';
import { documentRecord } from '../content/document-records.js';
import { type ChunkRow, type PageRow } from '../content/document-reader.js';
import {
  DocumentBatch, directoryStatements, PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, publicationStatement, publishedPromptScheme,
  PUBLISHED_RECORD_SCHEME, releaseHolders, reserveReached, type ChunkVersion, type Holder,
} from './document-batch.js';
import { convertDocuments } from './document-conversion.js';
import { locatePrompts } from './document-locators.js';
import { parseOnce, terminalRule, TRANSCRIPT_IDLE_MS, type ParsePersistence, type ParseTarget, type PassLimits } from './parse.js';
import { promptOwners, type ParserState } from './parsers/index.js';
import { admittedViewEvent, viewSourceReceipts } from './view-writer.js';
import { isPromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

/** Sessions one wake publishes. */
export const PUBLISH_SESSIONS_PER_WAKE = 4;
/** Queued member events one pass publishes. */
export const PUBLISH_QUEUE_PER_PASS = 200;
/** How long a superseded chunk version stays readable before its holder is retired. */
export const RETIRED_OBJECT_GRACE_MS = 15 * 60_000;
const RETIRE_PAGE = 100;
/** Errors that stop one transcript's publication by name rather than failing the pass. */
const PUBLISH_FAILURES: Readonly<Record<string, string>> = {
  view_record_too_large: 'record_too_large',
  document_record_too_large: 'record_too_large',
  view_record_kind_unsupported: 'event_refused',
  view_source_receipt_absent: 'receipt_absent',
  view_parser_absent: 'parser_absent',
};
const failureOf = (error: unknown): string | undefined => {
  if (!(error instanceof Error)) return undefined;
  if (error.message.startsWith('view_record_refused:')) return 'event_refused';
  return PUBLISH_FAILURES[error.message];
};

interface DocumentRow {
  generation: number; next_chunk: number; first_prompt: string | null; open_turn_key: string | null;
  prompts: number; token_id: string; ended_at: number | null; working_since: number | null; last_turn_end_at: number | null;
}
interface TranscriptRow {
  transcript_id: string; agent: string | null; role: string | null; size: number; machine_id: string; token_id: string;
  prompt_identity_scheme: string | null; imported_at: number | null; last_received_at: number;
  published_offset: number | null; segment_lines: number | null; open_prompt_id: string | null; unfinished: number | null;
  reply_unfinished: number | null; reply_latest_at: number | null; prompt_scheme: string | null; record_scheme: string | null;
  state: string | null; failure: string | null; awaited_size: number | null;
}
interface QueuedRow {
  event_id: string; rank: number; queued_created_at: number; kind: string; payload: string; payload_format: string; created_at: number;
  received_at: number;
}

interface Publication {
  transcript: TranscriptRow;
  held: number | null;
  offset: number;
  segmentLines: number;
  openPromptId: string | null;
  unfinished: number;
  replyUnfinished: number;
  replyLatestAt: number | null;
  promptScheme: string | null;
  recordScheme: string;
  state: 'active' | 'awaiting' | 'failed';
  failure: string | null;
  awaitedSize: number | null;
  changed: boolean;
}

/** The sessions due, oldest first, read from the due index without reading a queue or a document. */
async function dueSessions(db: RelationalStore, now: number, limit: number): Promise<{ project_id: string; session_id: string }[]> {
  return (await db.prepare(`SELECT d.project_id,d.session_id FROM session_documents d WHERE d.due_at<=? AND d.state='live'
      AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=d.project_id AND t.session_id=d.session_id)
    ORDER BY d.due_at,d.project_id,d.session_id LIMIT ?`)
    .bind(now, limit).all<{ project_id: string; session_id: string }>()).results;
}

/**
 * Publishes the due sessions within the wake's remaining budget, converts sessions that predate documents with what a
 * wake that published everything due has left, locates the prompts of documents written before page locators with
 * what conversion leaves, then retires superseded chunk versions past their grace. None of them spends the reserve the
 * wake keeps for its later jobs.
 */
export async function publishDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const due = await dueSessions(env.db, now, PUBLISH_SESSIONS_PER_WAKE);
  let changed = 0;
  let more = due.length === PUBLISH_SESSIONS_PER_WAKE;
  let failure: unknown;
  for (const ref of due) {
    if (limits.clock() >= limits.deadline || reserveReached(env.db, 2 * PASS_CLOSING_STATEMENTS, 2 * PASS_CLOSING_BLOB_CALLS)) {
      more = true;
      break;
    }
    try {
      const report = await new SessionPublication(env, ref.project_id, ref.session_id, now, limits).run();
      changed += report.records;
      more ||= report.more;
    } catch (error) {
      emit({ kind: 'document_publish_failed', projectId: ref.project_id, sessionId: ref.session_id, error: error instanceof Error ? error.message : 'unknown' });
      failure ??= error;
    }
  }
  if (!more && failure === undefined) {
    const converted = await convertDocuments(env, now, limits);
    changed += converted.changed;
    more ||= converted.more;
    if (!converted.more) {
      const located = await locatePrompts(env, limits);
      changed += located.changed;
      more ||= located.more;
    }
  }
  if (!reserveReached(env.db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) changed += await retireSupersededObjects(env.db, now);
  if (failure !== undefined) throw failure;
  return { changed, more };
}

/** Releases the holders past their grace. */
export async function retireSupersededObjects(db: RelationalStore, now: number): Promise<number> {
  const rows = (await db.prepare(`SELECT project_id p,session_id s,blob_key k,source_id i FROM retired_objects
    WHERE retired_at<=? ORDER BY retired_at LIMIT ${RETIRE_PAGE}`).bind(now - RETIRED_OBJECT_GRACE_MS).all<Holder>()).results;
  if (rows.length === 0) return 0;
  await releaseHolders(db, rows, now);
  return rows.length;
}

/** The body field a spilled payload `blob` holds for an event kind. */
const SPILLED_FIELD: Readonly<Record<string, string>> = { prompt: 'text', response: 'text', plan: 'content', 'tool.use': 'input', 'tool.failure': 'input' };

/** A spilled tool input as the field held it: its JSON value, or its text when the member spilled text that is not JSON. */
function spilledInput(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * A queued event's payload, with a spilled body read back into the field it stands for. Only an inline payload is
 * read from its row; any other is read through the verified event content reader, an archived one from its bundle.
 */
async function hydratedPayload(env: ContentStore, projectId: string, row: QueuedRow): Promise<Record<string, unknown>> {
  const body = row.payload_format === 'inline' ? row.payload : await eventContent(env, projectId, row.event_id);
  if (body === null) throw new Error('document_event_body_missing');
  const payload = JSON.parse(body) as Record<string, unknown>;
  const field = SPILLED_FIELD[row.kind];
  if (field === undefined || typeof payload.blob !== 'string') return payload;
  const blob = await env.db.prepare('SELECT generation,size FROM blobs WHERE project_id=? AND key=?')
    .bind(projectId, payload.blob).first<{ generation: string | null; size: number }>();
  if (blob === null) throw new Error('document_event_body_missing');
  const text = await readVerifiedContentText(env, blobObjectKey(projectId, payload.blob, blob.generation), blob.size, payload.blob);
  const { blob: _spilled, ...rest } = payload;
  return { ...rest, [field]: field === 'input' ? spilledInput(text) : text };
}

/** One pass over one session: its transcripts from their frontiers, then its queued events, committed together. */
class SessionPublication {
  private readonly db: RelationalStore;
  private doc!: DocumentRow;
  private batch!: DocumentBatch;
  private publications: Publication[] = [];
  private consumed: { r: number; c: number; e: string }[] = [];
  private more = false;
  private continuationChanged = false;

  constructor(
    private readonly env: Pick<ServerEnv, 'db' | 'blobs'>,
    private readonly projectId: string,
    private readonly sessionId: string,
    private readonly now: number,
    private readonly limits: PassLimits,
  ) {
    this.db = env.db;
  }

  private spent(): boolean {
    return this.batch.calls >= this.limits.calls || this.limits.clock() >= this.limits.deadline
      || reserveReached(this.db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS);
  }

  async run(): Promise<{ records: number; more: boolean }> {
    const db = this.db;
    const generation = '(SELECT generation FROM session_documents WHERE project_id=?1 AND session_id=?2)';
    const [docs, chunks, pages, transcripts, queued] = await db.batch([
      db.prepare(`SELECT d.generation,d.next_chunk,d.first_prompt,d.open_turn_key,d.prompts,s.created_by_token_id token_id,
          s.ended_at,s.working_since,s.last_turn_end_at
        FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
        WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation IS NOT NULL`).bind(this.projectId, this.sessionId),
      ...directoryStatements(db, this.projectId, this.sessionId),
      db.prepare(`SELECT t.transcript_id,t.agent,t.role,t.size,t.machine_id,t.token_id,t.prompt_identity_scheme,t.imported_at,t.last_received_at,
          p.published_offset,p.segment_lines,p.open_prompt_id,p.unfinished,p.reply_unfinished,p.reply_latest_at,p.prompt_scheme,p.record_scheme,
          p.state,p.failure,p.awaited_size
        FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=${generation}
        WHERE t.project_id=?1 AND t.session_id=?2 ORDER BY CASE t.role WHEN 'subagent' THEN 1 ELSE 0 END,t.first_received_at,t.transcript_id`)
        .bind(this.projectId, this.sessionId),
      db.prepare(`SELECT q.event_id,q.rank,q.created_at queued_created_at,e.kind,e.payload,e.payload_format,e.created_at,e.received_at
        FROM (SELECT rank,created_at,event_id FROM publish_queue WHERE project_id=?1 AND session_id=?2
          ORDER BY rank,created_at,event_id LIMIT ${PUBLISH_QUEUE_PER_PASS}) q
        JOIN events e ON e.project_id=?1 AND e.event_id=q.event_id ORDER BY q.rank,q.created_at,q.event_id`)
        .bind(this.projectId, this.sessionId),
    ]);
    const doc = docs!.results[0] as DocumentRow | undefined;
    if (doc === undefined) return { records: 0, more: false };
    this.doc = doc;
    this.batch = new DocumentBatch(this.env, this.projectId, this.sessionId, doc, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
    this.batch.calls += 1;
    await this.batch.open();
    this.publications = (transcripts!.results as TranscriptRow[]).map((t) => ({
      transcript: t, held: t.published_offset, offset: t.published_offset ?? 0, segmentLines: t.segment_lines ?? 0,
      openPromptId: t.open_prompt_id, unfinished: t.unfinished ?? 0, replyUnfinished: t.reply_unfinished ?? 0,
      replyLatestAt: t.reply_latest_at, promptScheme: t.published_offset === null ? publishedPromptScheme(t.prompt_identity_scheme) : t.prompt_scheme,
      recordScheme: t.record_scheme ?? PUBLISHED_RECORD_SCHEME, state: (t.state ?? 'active') as Publication['state'],
      failure: t.failure, awaitedSize: t.awaited_size, changed: t.published_offset === null,
    }));
    for (const publication of this.publications) await this.publishTranscript(publication);
    await this.publishQueued(queued!.results as QueuedRow[]);
    const written = await this.batch.commit(this.batch.writer.changed || this.continuationChanged, 'live', this.now, (version) => ({
      sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=?)
        AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
      params: [this.projectId, this.sessionId, doc.generation, this.projectId, this.sessionId, version.key, version.sourceId],
    }), (versions) => this.frontier(versions));
    if (written > 0) emit({ kind: 'document_published', projectId: this.projectId, sessionId: this.sessionId, records: this.batch.records, chunks: written });
    return { records: this.batch.records, more: this.more };
  }

  private target(publication: Publication, persistence: ParsePersistence): ParseTarget {
    const t = publication.transcript;
    const context = this.batch.writer.states.get(t.transcript_id) ?? null;
    return {
      persistence, projectId: this.projectId, sessionId: this.sessionId, transcriptId: t.transcript_id, machineId: t.machine_id,
      tokenId: t.token_id, agent: t.agent, parsedOffset: publication.offset, segmentLines: publication.segmentLines, size: t.size,
      fidelity: null, scheme: isPromptIdScheme(publication.promptScheme) ? publication.promptScheme : null,
      recordScheme: publication.recordScheme, openPromptId: publication.openPromptId, promptIdentityStale: false,
      parserContext: context, lastReceivedAt: t.last_received_at, sessionEndedAt: this.doc.ended_at, imported: t.imported_at !== null,
      ...(t.role === 'subagent' || t.role === 'primary' ? { role: t.role } : {}),
      turnEnded: this.doc.working_since === null && Number(this.doc.last_turn_end_at) > Number(context?.mycoParserReplyLatestAt),
    };
  }

  private async publishTranscript(publication: Publication): Promise<void> {
    const t = publication.transcript;
    if (publication.state === 'failed' || (publication.state === 'awaiting' && t.size <= (publication.awaitedSize ?? -1))) return;
    const receipts = new Map<number, number>();
    const claims = new Map<string, { thread: string; record: string }>();
    const persistence: ParsePersistence = {
      sourceTimes: (offsets) => viewSourceReceipts(this.db, this.projectId, t.transcript_id, offsets, receipts),
      checkpoint: async () => { throw new Error('document_continuation_chunked'); },
      owners: async () => promptOwners([...this.batch.writer.owners, ...[...claims].filter(([key]) => !this.batch.writer.owners.has(key))]),
      claim: async (incoming) => { for (const claim of incoming) claims.set(claim.key, { thread: claim.thread, record: claim.record }); },
      stop: async (failure) => { Object.assign(publication, { state: 'failed', failure, changed: true }); },
      awaitBytes: async () => { Object.assign(publication, { state: 'awaiting', awaitedSize: t.size, changed: true }); },
      header: async (metadata) => {
        this.batch.writer.states.set(t.transcript_id, metadata);
        this.continuationChanged = true;
      },
      publish: async (window) => {
        const records = window.events.map((event) => {
          const admitted = admittedViewEvent(event, this.now);
          const known = typeof admitted.payload.toolName === 'string' && admitted.payload.toolName !== 'unknown';
          return documentRecord(admitted.kind, admitted.payload, admitted.createdAt, {
            src: [t.transcript_id, event.offset, event.sourceEnd ?? window.to],
            received_at: receipts.get(event.offset) ?? t.last_received_at,
            call: known ? { ordinal: 0, offset: event.callOffset ?? event.offset, origin: 'reported' } : null,
            outcome: { ordinal: 0, offset: event.outcomeOffset ?? event.offset, origin: event.outcomeOrigin ?? 'reported' },
          });
        }).filter((record): record is DocRecord => record !== null);
        await this.batch.place(records, t.agent);
        for (const [key, owner] of claims) if (!this.batch.writer.owners.has(key)) this.batch.writer.owners.set(key, owner);
        claims.clear();
        const state: ParserState = window.state;
        delete state.findings;
        delete state.unattributed;
        const unfinished = Object.keys(state.pending ?? {}).length > 0 || state.reply !== undefined ? 1 : 0;
        const replyLatestAt = state.reply?.parts.reduce((latest, part) => Math.max(latest, part.createdAt), 0) ?? null;
        this.batch.writer.states.set(t.transcript_id, {
          mycoParserViewCheckpoint: 1, mycoParserMeta: window.metadata ?? null, mycoParserReadSize: window.to,
          mycoParserUnfinished: unfinished, mycoParserReplyUnfinished: state.reply === undefined ? 0 : 1,
          mycoParserReplyLatestAt: replyLatestAt, mycoParserState: state,
        });
        Object.assign(publication, {
          offset: window.to, segmentLines: window.segmentLines, openPromptId: window.openPromptId, unfinished,
          replyUnfinished: state.reply === undefined ? 0 : 1, replyLatestAt, state: 'active', failure: null, awaitedSize: null, changed: true,
        });
        this.continuationChanged = true;
        return 0;
      },
    };
    for (;;) {
      if (this.spent()) { this.more = true; return; }
      const context = this.batch.writer.states.get(t.transcript_id);
      if (publication.offset >= t.size) {
        if (publication.unfinished !== 1 || context?.mycoParserUnfinished !== 1) return;
        if (terminalRule(this.target(publication, persistence), this.now, this.limits) === undefined) return;
      }
      const from = publication.offset;
      const wasUnfinished = publication.unfinished;
      try {
        const report = await parseOnce(this.env, this.target(publication, persistence), this.now, {
          ...this.limits, calls: Math.max(1, this.limits.calls - this.batch.calls),
        });
        this.batch.calls += report.calls;
        if (report.nextOffset === null || publication.state !== 'active') return;
        if (publication.offset === from && (from < t.size || publication.unfinished === wasUnfinished)) return;
      } catch (error) {
        const failure = failureOf(error);
        if (failure === undefined) throw error;
        Object.assign(publication, { state: 'failed', failure, changed: true });
        emit({ kind: 'document_transcript_failed', projectId: this.projectId, transcriptId: t.transcript_id, failure });
        return;
      }
    }
  }

  private async publishQueued(rows: readonly QueuedRow[]): Promise<void> {
    if (rows.length === PUBLISH_QUEUE_PER_PASS) this.more = true;
    const records: DocRecord[] = [];
    const content = bundleContentEnv(this.env);
    for (const row of rows) {
      if (this.spent()) { this.more = true; break; }
      const payload = await hydratedPayload(content, this.projectId, row);
      const record = documentRecord(row.kind, payload, row.created_at, { ev: row.event_id, received_at: row.received_at });
      if (record !== null) records.push(record);
      this.consumed.push({ r: row.rank, c: row.queued_created_at, e: row.event_id });
    }
    await this.batch.place(records, null);
  }

  /** The guard and frontier statements a publication commits around the batch's catalog writes. */
  private frontier(versions: readonly ChunkVersion[]): { before: PreparedStatement[]; after: PreparedStatement[] } {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const publications = this.publications.filter((publication) => publication.changed);
    const expectedOffsets = publications.map((publication) => ({ t: publication.transcript.transcript_id, o: publication.held }));
    const consumed = JSON.stringify(this.consumed);
    const before = contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=? AND next_chunk=?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
          AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN transcript_publication t ON t.project_id=? AND t.generation=?
          AND t.transcript_id=json_extract(j.value,'$.t') WHERE t.published_offset IS NOT json_extract(j.value,'$.o'))
        AND (SELECT COUNT(*) FROM json_each(?) j JOIN publish_queue q ON q.project_id=? AND q.session_id=? AND q.rank=json_extract(j.value,'$.r')
          AND q.created_at=json_extract(j.value,'$.c') AND q.event_id=json_extract(j.value,'$.e'))=?`,
      [p, s, g, this.doc.next_chunk, this.batch.expectedChunks(versions), p, s, g, JSON.stringify(expectedOffsets), p, g,
        consumed, p, s, this.consumed.length]);
    const after: PreparedStatement[] = [];
    if (publications.length > 0) after.push(publicationStatement(db, p, s, g, this.now, publications.map((pub) => ({
      t: pub.transcript.transcript_id, o: pub.offset, l: pub.segmentLines, p: pub.openPromptId, u: pub.unfinished, r: pub.replyUnfinished,
      a: pub.replyLatestAt, ps: pub.promptScheme, rs: pub.recordScheme, s: pub.state, f: pub.failure, w: pub.awaitedSize,
    }))));
    if (this.consumed.length > 0) {
      after.push(db.prepare(`DELETE FROM publish_queue WHERE (project_id,session_id,rank,created_at,event_id) IN
          (SELECT ?,?,json_extract(value,'$.r'),json_extract(value,'$.c'),json_extract(value,'$.e') FROM json_each(?))`)
        .bind(p, s, consumed));
    }
    const sizes = Object.fromEntries(this.publications.map((pub) => [pub.transcript.transcript_id, pub.transcript.size]));
    const behind = this.publications.some((pub) => pub.state === 'active' && pub.offset < pub.transcript.size);
    const terminalDue = this.publications.filter((pub) => pub.state !== 'failed' && pub.unfinished === 1)
      .map((pub) => pub.transcript.last_received_at + TRANSCRIPT_IDLE_MS);
    const dueAt = behind || this.more ? 0 : terminalDue.length === 0 ? null : Math.min(...terminalDue);
    const set = this.batch.documentSet(this.now);
    after.push(db.prepare(`UPDATE session_documents SET ${set.sql},
        due_at=CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id=? AND t.session_id=?
          AND t.size IS NOT json_extract(?, '$."' || t.transcript_id || '"'))
          OR EXISTS (SELECT 1 FROM publish_queue q WHERE q.project_id=? AND q.session_id=?) THEN 0 ELSE ? END
      WHERE project_id=? AND session_id=?`)
      .bind(...set.params, p, s, JSON.stringify(sizes), p, s, dueAt, p, s));
    return { before, after };
  }
}
