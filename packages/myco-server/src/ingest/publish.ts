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
 *
 * A transcript stops for good only on a failure its own bytes repeat. A segment whose object or receipt cannot be read
 * is a fault that can clear: the transcript keeps its frontier, the session's other input publishes, and the session
 * comes due again after a backoff. A cursor no segment covers waits the same way: the frontier never passes unread bytes.
 *
 * A window that cannot be placed and committed within the pass's budget is offered again shorter, down to one line, and
 * a line that still does not fit commits the leading records that do. The publication then keeps its offset and parser
 * state and records how many of the records derived from there are placed, with a digest of what they hold. The next pass
 * derives from the same state and places only the rest, so every pass over unchanged input advances. A derivation whose
 * leading records hold anything else, such as a real result where a close placed a failure, places them all again, and
 * each merges into the record it already is.
 */
import type { ContentStore, PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion } from '../core/registered-content.js';
import { bundleContentEnv } from '../core/archive-bundle.js';
import { eventContent } from '../core/event-content.js';
import { emit } from '../telemetry.js';
import { sha256Hex } from '../hash.js';
import { BACKLOG_CHAINED_WAKE_MS } from '../core/tick.js';
import { type DocRecord } from '../content/document.js';
import { documentRecord } from '../content/document-records.js';
import { type ChunkRow, type PageRow } from '../content/document-reader.js';
import {
  commitAdmitted, DocumentBatch, DocumentPassFull, directoryStatements, PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, publicationStatement,
  releaseHolders, reserveReached, type ChunkVersion, type Holder,
} from './document-batch.js';
import { dueSessions, deferFailedPublication, PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS, type DueSession } from '../db/documents/publication.js';
import { recordDocumentPublishFailure } from '../core/attention-state.js';
import { settleCards } from './card-settle.js';
import { locatePrompts } from './document-locators.js';
import {
  parseOnce, terminalRule, TRANSCRIPT_IDLE_MS, TRANSCRIPT_PARSE_SEGMENTS_PER_READ, type ParsePersistence, type ParseTarget, type PassLimits,
} from './parse.js';
import { promptOwners, type ParserState } from './parsers/index.js';
import { admittedDocumentEvent, sourceReceipts } from './document-admission.js';
import { DOCUMENT_TEXT_FIELDS, documentText } from './document-text.js';
import { publicationPolicy } from './publication-policy.js';
import { UnknownPluginFormat } from './parsers/plugin-events.js';
import { isPromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

/** Sessions one wake publishes. */
export const PUBLISH_SESSIONS_PER_WAKE = 4;
/** Queued member events one pass publishes. */
export const PUBLISH_QUEUE_PER_PASS = 200;
/** How long a superseded chunk version stays readable before its holder is retired. */
export const RETIRED_OBJECT_GRACE_MS = 15 * 60_000;
const RETIRE_PAGE = 100;
/** What one parse step may spend before it places its window: its segment reads and its catalog statements. */
const STEP_STATEMENTS = 24;
const STEP_BLOB_CALLS = TRANSCRIPT_PARSE_SEGMENTS_PER_READ;
/** What reading one queued event may spend: its row, its bundle and its spilled body, and resolving its prompt. */
const QUEUED_STATEMENTS = 8;
const QUEUED_BLOB_CALLS = 4;
/** How long a failed session pass waits before retrying: the time from its last advance, within bounds. */
export { PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS };
/** A named diagnostic code when an exception carries one. */
const namedFailure = (error: unknown): string | undefined =>
  error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : undefined;
/** Failures with a declared terminal hold or source-recovery policy. */
const PUBLISH_FAILURES: Readonly<Record<string, string>> = {
  view_record_too_large: 'record_too_large',
  document_record_too_large: 'record_too_large',
  view_record_kind_unsupported: 'event_refused',
  view_source_receipt_absent: 'receipt_absent',
  view_parser_absent: 'parser_absent',
  content_text_invalid: 'content_text_invalid',
  document_event_payload_invalid: 'document_event_payload_invalid',
};
/** Stops that can clear on the same bytes. A publication holding one, however it came to, is retried. */
const CLEARABLE_FAILURES: ReadonlySet<string | null> = new Set(['blob_absent', 'receipt_absent']);
function publicationOutcome(error: unknown): { failure: string; terminal: boolean; propagate: boolean } {
  const declared = error instanceof Error && Object.hasOwn(PUBLISH_FAILURES, error.message) ? PUBLISH_FAILURES[error.message] : undefined;
  const known = error instanceof UnknownPluginFormat ? 'format_unsupported'
    : error instanceof Error && error.message.startsWith('view_record_refused:') ? 'event_refused' : declared;
  const failure = known ?? namedFailure(error) ?? 'publication_failed';
  return { failure, terminal: known !== undefined && !CLEARABLE_FAILURES.has(failure), propagate: known === undefined && namedFailure(error) === undefined };
}

interface DocumentRow {
  generation: number; next_chunk: number; first_prompt: string | null; open_turn_key: string | null;
  prompts: number; token_id: string; ended_at: number | null; working_since: number | null; last_turn_end_at: number | null;
}
interface TranscriptRow {
  transcript_id: string; agent: string | null; role: string | null; size: number; machine_id: string; token_id: string;
  prompt_identity_scheme: string | null; imported_at: number | null; last_received_at: number;
  publication_parser_version: number | null; diagnostic: string | null; published_offset: number | null; segment_lines: number | null; open_prompt_id: string | null; unfinished: number | null;
  reply_unfinished: number | null; reply_latest_at: number | null; prompt_scheme: string | null; record_scheme: string | null;
  state: string | null; failure: string | null; awaited_size: number | null; updated_at: number | null;
  placed_records: number | null; placed_digest: string | null;
}
interface QueuedRow {
  event_id: string; rank: number; retry_at: number; retry_cause: string | null; queued_created_at: number; kind: string; payload: string; payload_format: string; created_at: number;
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
  /** The leading records derived from `offset` already placed, and the digest of what they hold. */
  placedRecords: number | null;
  placedDigest: string | null;
  changed: boolean;
  /** A fault this pass met that can clear: the transcript waits at its frontier. */
  fault?: string;
  faultError?: unknown;
  diagnostic?: import('./parse.js').ParseDiagnostic;
}

/** Publishes due sessions, locates prompts, settles cards and retires superseded chunks within the wake budget. */
export async function publishDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const due = await dueSessions(env.db, now, PUBLISH_SESSIONS_PER_WAKE);
  let changed = 0;
  let more = due.length === PUBLISH_SESSIONS_PER_WAKE;
  let failure: unknown;
  for (const [index, ref] of due.entries()) {
    if (limits.clock() >= limits.deadline || reserveReached(env.db, 2 * PASS_CLOSING_STATEMENTS, 2 * PASS_CLOSING_BLOB_CALLS)) {
      more = true;
      break;
    }
    try {
      const report = await new SessionPublication(env, ref.project_id, ref.session_id, now, limits).run(index === 0);
      changed += report.records;
      more ||= report.more;
      if (report.failure?.propagate) failure ??= report.failure.error;
    } catch (error) {
      const outcome = publicationOutcome(error);
      emit({ kind: 'document_publish_failed', projectId: ref.project_id, sessionId: ref.session_id, error: outcome.failure });
      try { await deferFailedSession(env.db, ref, outcome.failure, now); }
      catch (deferralError) { failure ??= deferralError; }
      if (outcome.propagate) failure ??= error;
    }
  }
  if (!more) {
    const located = await locatePrompts(env, limits);
    changed += located.changed;
    more ||= located.more;
  }

  const cards = await settleCards(env, now, limits);
  changed += cards.settled;
  more ||= cards.more;
  if (!reserveReached(env.db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) changed += await retireSupersededObjects(env.db, now);
  if (failure !== undefined) throw failure;
  return { changed, more };
}

/**
 * Records a failed pass and defers unchanged input through its retry deadline.
 * Input that arrived during the pass keeps the session due.
 */
async function deferFailedSession(db: RelationalStore, ref: DueSession, failure: string, now: number): Promise<void> {
  const { project_id: projectId, session_id: sessionId } = ref;
  try {
    await deferFailedPublication(db, ref, now);
    await recordDocumentPublishFailure(db, { projectId, sessionId, failure }, now);
  } catch (error) {
    emit({ kind: 'document_publish_deferral_failed', projectId, sessionId, error: namedFailure(error) ?? 'unknown' });
    throw error;
  }
}

/** The transcript-parse job publishes documents within the wake's declared job budget. */
export async function runPublishWake(env: ServerEnv, now: number): Promise<{ changed: number; more: boolean; continueAfterMs?: number }> {
  const report = await publishDocuments(env, now, { calls: env.platform.jobBudget.calls, deadline: Date.now() + env.platform.jobBudget.wallMs, clock: Date.now });
  return report;
}

/** Releases the holders past their grace. */
export async function retireSupersededObjects(db: RelationalStore, now: number): Promise<number> {
  const rows = (await db.prepare(`SELECT project_id p,session_id s,blob_key k,source_id i FROM retired_objects
    WHERE retired_at<=? ORDER BY retired_at LIMIT ${RETIRE_PAGE}`).bind(now - RETIRED_OBJECT_GRACE_MS).all<Holder>()).results;
  if (rows.length === 0) return 0;
  await releaseHolders(db, rows, now);
  return rows.length;
}

/** A spilled tool input retains its JSON value or its original text. */
function spilledInput(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** A queued event's complete payload, read from its original evidence and verified text references. */
async function hydratedPayload(env: ContentStore, projectId: string, row: QueuedRow, observe: (payload: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
  const body = row.payload_format === 'inline' ? row.payload : await eventContent(env, projectId, row.event_id);
  if (body === null) throw new Error('document_event_body_missing');
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('document_event_payload_invalid');
    payload = parsed as Record<string, unknown>;
  } catch (error) { throw new Error('document_event_payload_invalid', { cause: error }); }
  observe(payload);
  for (const [reference, field] of Object.entries(DOCUMENT_TEXT_FIELDS[row.kind] ?? {})) {
    const key = payload[reference];
    if (typeof key !== 'string') continue;
    const text = await documentText(env, projectId, key);
    payload[field] = field === 'input' ? spilledInput(text) : text;
    delete payload[reference];
  }
  return payload;
}

interface QueuedRef { r: number; c: number; e: string; t: number; w: string | null }
type QueuedWaitCause = { kind: 'read'; parentId: string | null } | { kind: 'prompt' | 'order'; eventId: string };
interface QueuedFailure extends QueuedRef { failure: string | null; retry: number; code: string; cause: QueuedWaitCause | null; error?: unknown }
interface QueuedRecord { consumed: QueuedRef; record: DocRecord | null; failure?: QueuedFailure }
interface PublicationReport { records: number; more: boolean; failure?: { error: unknown; propagate: boolean } }

/** What a run of records holds, in order. */
const recordsDigest = (records: readonly DocRecord[]): Promise<string> => sha256Hex(JSON.stringify(records));

/** One pass over one session: its transcripts from their frontiers, then its queued events, committed together. */
class SessionPublication {
  private readonly db: RelationalStore;
  private doc!: DocumentRow;
  private batch!: DocumentBatch;
  private publications: Publication[] = [];
  private consumed: QueuedRef[] = [];
  private failedQueued: QueuedFailure[] = [];
  private readonly placedPrompts = new Set<string>();
  private more = false;
  private full = false;
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

  /** Whether the pass must stop before a step that could spend `statements` and `blobCalls`: its commit stays payable. */
  private spent(statements = STEP_STATEMENTS, blobCalls = STEP_BLOB_CALLS): boolean {
    return this.full || this.batch.calls >= this.limits.calls || this.limits.clock() >= this.limits.deadline
      || !commitAdmitted(this.db, this.batch.writer.versions, statements + this.batch.commitStatements, blobCalls);
  }

  /**
   * Publishes what the pass can pay for and commits it. A pass that leads its wake and cannot place even one record
   * fails as `document_pass_unaffordable`: every later pass on the same input would stop at the same place.
   */
  async run(leads = false): Promise<PublicationReport> {
    const db = this.db;
    const generation = '(SELECT generation FROM session_documents WHERE project_id=?1 AND session_id=?2)';
    const policy = publicationPolicy('t.prompt_identity_scheme');
    const [docs, chunks, pages, transcripts, queued] = await db.batch([
      db.prepare(`SELECT d.generation,d.next_chunk,d.first_prompt,d.open_turn_key,d.prompts,s.created_by_token_id token_id,
          s.ended_at,s.working_since,s.last_turn_end_at
        FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
        WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation IS NOT NULL`).bind(this.projectId, this.sessionId),
      ...directoryStatements(db, this.projectId, this.sessionId),
      db.prepare(`SELECT t.transcript_id,t.agent,t.role,t.size,t.machine_id,t.token_id,t.prompt_identity_scheme,t.imported_at,t.last_received_at,
          p.parser_version AS publication_parser_version,p.diagnostic,p.published_offset,p.segment_lines,p.open_prompt_id,p.unfinished,p.reply_unfinished,p.reply_latest_at,
          CASE WHEN p.published_offset IS NULL THEN ${policy.prompt} ELSE p.prompt_scheme END prompt_scheme,
          CASE WHEN p.published_offset IS NULL THEN ${policy.record} ELSE p.record_scheme END record_scheme,
          p.state,p.failure,p.awaited_size,p.updated_at,p.placed_records,p.placed_digest
        FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=${generation}
        WHERE t.project_id=?1 AND t.session_id=?2 ORDER BY CASE t.role WHEN 'subagent' THEN 1 ELSE 0 END,t.first_received_at,t.transcript_id`)
        .bind(this.projectId, this.sessionId),
      db.prepare(`SELECT q.event_id,q.rank,q.retry_at,q.retry_cause,q.created_at queued_created_at,e.kind,e.payload,e.payload_format,e.created_at,e.received_at
        FROM (SELECT rank,created_at,event_id,retry_at,retry_cause FROM publish_queue WHERE project_id=?1 AND session_id=?2 AND failure IS NULL AND (retry_at<=?3 OR retry_cause IS NULL)
          ORDER BY rank,created_at,event_id LIMIT ${PUBLISH_QUEUE_PER_PASS}) q
        JOIN events e ON e.project_id=?1 AND e.event_id=q.event_id ORDER BY q.rank,q.created_at,q.event_id`)
        .bind(this.projectId, this.sessionId, this.now),
    ]);
    const doc = docs!.results[0] as DocumentRow | undefined;
    if (doc === undefined) return { records: 0, more: false };
    this.doc = doc;
    this.batch = new DocumentBatch(this.env, this.projectId, this.sessionId, doc, chunks!.results as ChunkRow[], pages!.results as PageRow[]);
    this.batch.calls += 1;
    await this.batch.open();
    this.batch.admitted = true;
    this.publications = (transcripts!.results as TranscriptRow[]).map((t) => {
      const cleared = t.state === 'failed' && CLEARABLE_FAILURES.has(t.failure);
      return {
        transcript: t, held: t.published_offset, offset: t.published_offset ?? 0, segmentLines: t.segment_lines ?? 0,
        openPromptId: t.open_prompt_id, unfinished: t.unfinished ?? 0, replyUnfinished: t.reply_unfinished ?? 0,
        replyLatestAt: t.reply_latest_at, promptScheme: t.prompt_scheme,
        recordScheme: t.record_scheme!, state: (cleared ? 'active' : t.state ?? 'active') as Publication['state'],
        diagnostic: cleared || t.diagnostic===null ? undefined : JSON.parse(t.diagnostic), failure: cleared ? null : t.failure, awaitedSize: t.awaited_size, placedRecords: t.placed_records, placedDigest: t.placed_digest,
        changed: cleared || t.published_offset === null,
      };
    });
    for (const publication of this.publications) await this.publishTranscript(publication);
    await this.publishQueued(queued!.results as QueuedRow[]);
    const placed = this.batch.writer.changed || this.continuationChanged || this.consumed.length > 0 || this.failedQueued.length > 0 || this.batch.writer.sealing().length > 0;
    if (leads && this.full && !placed) throw new Error('document_pass_unaffordable');
    const written = await this.batch.commit(this.batch.writer.changed || this.continuationChanged, 'live', this.now, (version) => ({
      sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=?)
        AND EXISTS (SELECT 1 FROM retired_objects WHERE project_id=? AND session_id=? AND blob_key=? AND source_id=?)`,
      params: [this.projectId, this.sessionId, doc.generation, this.projectId, this.sessionId, version.key, version.sourceId],
    }), (versions) => this.frontier(versions));
    if (written > 0) emit({ kind: 'document_published', projectId: this.projectId, sessionId: this.sessionId, records: this.batch.records, chunks: written });
    const fault = this.publications.find((publication) => publication.fault !== undefined)?.fault
      ?? this.failedQueued.find(row => row.error !== undefined)?.code;
    const retryError = this.publications.find(publication => publication.faultError !== undefined)?.faultError
      ?? this.failedQueued.find(row => row.failure === null && row.error !== undefined)?.error;
    let failure: PublicationReport['failure'] = retryError === undefined ? undefined : { error: retryError, propagate: publicationOutcome(retryError).propagate };
    if (fault !== undefined) {
      try { await recordDocumentPublishFailure(db, { projectId: this.projectId, sessionId: this.sessionId, failure: fault }, this.now); }
      catch (error) { failure = { error, propagate: true }; }
    }
    return { records: this.batch.records, more: this.more, failure };
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
    if (publication.offset === 0 || t.publication_parser_version === 0) this.batch.writer.states.delete(t.transcript_id);
    const receipts = new Map<number, number>();
    const claims = new Map<string, { thread: string; record: string }>();
    const persistence: ParsePersistence = {
      sourceTimes: (offsets) => sourceReceipts(this.db, this.projectId, t.transcript_id, offsets, receipts),
      checkpoint: async () => { throw new Error('document_continuation_chunked'); },
      owners: async () => promptOwners([...this.batch.writer.owners, ...[...claims].filter(([key]) => !this.batch.writer.owners.has(key))]),
      claim: async (incoming) => { for (const claim of incoming) claims.set(claim.key, { thread: claim.thread, record: claim.record }); },
      stop: async (failure, _now, diagnostic) => {
        if (CLEARABLE_FAILURES.has(failure)) this.recordFault(publication, failure);
        else Object.assign(publication, { diagnostic, state: 'failed', failure, changed: true });
      },
      awaitBytes: async () => { Object.assign(publication, { state: 'awaiting', awaitedSize: t.size, changed: true }); },
      header: async (metadata) => {
        this.batch.writer.states.set(t.transcript_id, metadata);
        this.continuationChanged = true;
      },
      publish: async (window) => {
        const records = window.events.map((event) => {
          const admitted = admittedDocumentEvent(event, this.now);
          const known = typeof admitted.payload.toolName === 'string' && admitted.payload.toolName !== 'unknown';
          return documentRecord(admitted.kind, admitted.payload, admitted.createdAt, {
            src: [t.transcript_id, event.offset, event.sourceEnd ?? window.to],
            received_at: receipts.get(event.offset) ?? t.last_received_at,
            call: known ? { ordinal: 0, offset: event.callOffset ?? event.offset, origin: 'reported' } : null,
            outcome: { ordinal: 0, offset: event.outcomeOffset ?? event.offset, origin: event.outcomeOrigin ?? 'reported' },
          });
        }).filter((record): record is DocRecord => record !== null);
        const placed = await this.placedOf(publication, records);
        const rest = records.slice(placed);
        const adoptClaims = () => {
          for (const [key, owner] of claims) if (!this.batch.writer.owners.has(key)) this.batch.writer.owners.set(key, owner);
          claims.clear();
        };
        if (!await this.placeable(rest, t.agent)) {
          this.full = this.more = true;
          if (window.lines < 2) {
            const taken = await this.placeLeading(rest, t.agent);
            if (taken > 0) {
              adoptClaims();
              Object.assign(publication, {
                placedRecords: placed + taken, placedDigest: await recordsDigest(records.slice(0, placed + taken)),
                state: 'active', failure: null, awaitedSize: null, changed: true,
              });
              this.continuationChanged = true;
            }
          }
          claims.clear();
          return null;
        }
        adoptClaims();
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
          replyUnfinished: state.reply === undefined ? 0 : 1, replyLatestAt, state: 'active', diagnostic: undefined, failure: null, awaitedSize: null,
          placedRecords: null, placedDigest: null, changed: true,
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
        const { failure, terminal } = publicationOutcome(error);
        if (!terminal) {
          if (!CLEARABLE_FAILURES.has(failure)) publication.faultError = error;
          this.recordFault(publication, failure);
          return;
        }
        Object.assign(publication, { state: 'failed', failure, changed: true });
        emit({ kind: 'document_transcript_failed', projectId: this.projectId, transcriptId: t.transcript_id, failure });
        return;
      }
    }
  }

  /** How many of a derivation's leading records are placed: the publication's count while they hold what its digest names. */
  private async placedOf(publication: Publication, records: readonly DocRecord[]): Promise<number> {
    const placed = publication.placedRecords;
    if (placed === null || placed > records.length) return 0;
    return await recordsDigest(records.slice(0, placed)) === publication.placedDigest ? placed : 0;
  }

  /** Places these records, or leaves the batch unchanged and answers false when its commit could not be paid. */
  private async placeable(records: readonly DocRecord[], harness: string | null): Promise<boolean> {
    try {
      await this.batch.place(records, harness);
      return true;
    } catch (error) {
      if (error instanceof DocumentPassFull) return false;
      throw error;
    }
  }

  /** Places a leading run of these records, in steps that halve while the commit stays payable, and returns its length. */
  private async placeLeading(records: readonly DocRecord[], harness: string | null): Promise<number> {
    let taken = 0;
    for (let step = records.length >> 1; step > 0; step >>= 1) if (await this.placeable(records.slice(taken, taken + step), harness)) taken += step;
    return taken;
  }

  private recordFault(publication: Publication, failure: string): void {
    publication.fault = failure;
    emit({ kind: 'document_transcript_fault', projectId: this.projectId, transcriptId: publication.transcript.transcript_id, failure });
  }

  /** When a transcript waiting out a fault is tried again: the time from its last advance, within the session backoff. */
  private faultDue(publication: Publication): number {
    const since = this.now - (publication.transcript.updated_at ?? this.now);
    return this.now + Math.min(Math.max(since, PUBLISH_BACKOFF_MIN_MS), PUBLISH_BACKOFF_MAX_MS);
  }

  /**
   * Places the queued events in groups of one, two, four and on, each group read and placed before the next is read,
   * so reading never spends what placing the events already read needs. A group stops at the longest leading run
   * whose commit the pass can still pay.
   */
  private async publishQueued(rows: readonly QueuedRow[]): Promise<void> {
    if (rows.length === PUBLISH_QUEUE_PER_PASS) this.more = true;
    const content = bundleContentEnv(this.env);
    for (let at = 0, size = 1; at < rows.length; size *= 2) {
      const group: QueuedRecord[] = [];
      for (const row of rows.slice(at, at + size)) {
        if (this.spent(QUEUED_STATEMENTS, QUEUED_BLOB_CALLS)) { this.more = true; break; }
        const ref = { r: row.rank, c: row.queued_created_at, e: row.event_id, t: row.retry_at, w: row.retry_cause };
        const origin = { ev: row.event_id, received_at: row.received_at };
        let parentId: string | null = null;
        try {
          const payload = await hydratedPayload(content, this.projectId, row, payload => {
            const header = row.kind === 'prompt' ? documentRecord(row.kind, payload, row.created_at, origin) : null;
            parentId = header?.k === 'prompt' && typeof header.parent_prompt_id === 'string' ? header.parent_prompt_id : null;
          });
          group.push({ consumed: ref, record: documentRecord(row.kind, payload, row.created_at, origin) });
        } catch (error) {
          const outcome = publicationOutcome(error);
          const delay = Math.min(Math.max(row.retry_at - row.received_at, PUBLISH_BACKOFF_MIN_MS), PUBLISH_BACKOFF_MAX_MS);
          group.push({ consumed: ref, record: null, failure: { ...ref, failure: outcome.terminal ? outcome.failure : null,
            retry: this.now + delay, code: outcome.failure, cause: outcome.terminal ? null : { kind: 'read', parentId }, error } });
        }
      }
      let take = group.length, ready: QueuedRecord[] = [];
      for (; take > 0; take = Math.floor(take / 2)) {
        ready = await this.readyQueued(group.slice(0, take));
        try {
          await this.batch.place(ready.flatMap(({ record }) => (record === null ? [] : [record])), null);
          break;
        } catch (error) {
          if (!(error instanceof DocumentPassFull)) throw error;
          this.full = this.more = true;
        }
      }
      for (const row of ready.slice(0, take)) {
        if (row.record?.k === 'prompt') this.placedPrompts.add(row.record.id);
        if (row.failure === undefined) this.consumed.push(row.consumed);
        else this.failedQueued.push(row.failure);
      }
      if (take < size || this.full) return;
      at += take;
    }
  }

  /** Dependency cycles publish as unrooted session content. */
  private async cyclicQueued(heads: readonly { head: string; start: string }[], outcomes: readonly Pick<QueuedFailure, 'e' | 'failure' | 'retry' | 'cause'>[]): Promise<ReadonlySet<string>> {
    if (heads.length === 0) return new Set();
    const cause = 'COALESCE(o.cause,q.retry_cause)';
    const result = await this.db.prepare(`WITH RECURSIVE
      staged AS MATERIALIZED (SELECT json_extract(value,'$.e') e,json_extract(value,'$.failure') failure,json_extract(value,'$.cause') cause FROM json_each(?4)),
      walk(head,id) AS (
        SELECT json_extract(value,'$.head'),json_extract(value,'$.start') FROM json_each(?3)
        UNION
        SELECT w.head,json_extract(${cause},'$.eventId') FROM walk w CROSS JOIN events e CROSS JOIN publish_queue q
          LEFT JOIN staged o ON o.e=q.event_id
        WHERE e.project_id=?1 AND e.event_id=w.id AND q.project_id=?1 AND q.session_id=?2 AND q.rank=0
          AND q.created_at=e.created_at AND q.event_id=w.id AND q.failure IS NULL AND o.failure IS NULL
          AND json_extract(${cause},'$.kind')='prompt' AND json_extract(${cause},'$.eventId') IS NOT NULL
      )
      SELECT w.head,MAX(w.id=w.head) closes,MIN(CASE WHEN q.event_id IS NOT NULL AND q.failure IS NULL AND o.failure IS NULL
        AND json_extract(${cause},'$.kind')='prompt' THEN 1 ELSE 0 END) cycle
      FROM walk w LEFT JOIN events e ON e.project_id=?1 AND e.event_id=w.id
        LEFT JOIN publish_queue q ON q.project_id=?1 AND q.session_id=?2 AND q.rank=0 AND q.created_at=e.created_at AND q.event_id=w.id
        LEFT JOIN staged o ON o.e=q.event_id GROUP BY w.head`)
      .bind(this.projectId, this.sessionId, JSON.stringify(heads), JSON.stringify(outcomes))
      .all<{ head: string; closes: number; cycle: number }>();
    this.batch.calls += 1;
    return new Set(result.results.filter(row => row.closes === 1 || row.cycle === 1).map(row => row.head));
  }

  /** Read faults can hold turn order; parent waits retain their own dependency. */
  private async readyQueued(rows: readonly QueuedRecord[]): Promise<QueuedRecord[]> {
    const parentOf = (record: DocRecord): unknown => record.k === 'prompt' ? record.parent_prompt_id : record.prompt_id;
    const independent = (record: DocRecord | null): boolean => record?.k === 'prompt' && typeof parentOf(record) !== 'string';
    const ids = [...new Set(rows.flatMap(({ record }) => {
      const id = record === null ? null : parentOf(record);
      return typeof id === 'string' && !this.placedPrompts.has(id) ? [id] : [];
    }))];
    if (ids.length === 0 && !rows.some(row => independent(row.record))) return [...rows];
    const faults = [...this.failedQueued, ...rows.flatMap(row => row.failure === undefined ? [] : [row.failure])];
    const outcomes = faults.map(({ e, failure, retry, cause }) => ({ e, failure, retry, cause }));
    const held = ids.length === 0 ? [] : (await this.db.prepare(`WITH held AS MATERIALIZED (
      SELECT j.value id,(SELECT json_object('e',q.event_id,'retry',COALESCE(
        (SELECT json_extract(value,'$.retry') FROM json_each(?4) WHERE json_extract(value,'$.e')=q.event_id),q.retry_at))
      FROM event_refs r CROSS JOIN events e CROSS JOIN publish_queue q
      WHERE r.project_id=?1 AND r.session_id=?2 AND r.kind='prompt' AND r.record_id=j.value AND r.record_id IS NOT NULL
        AND e.project_id=r.project_id AND e.event_id=r.event_id
        AND q.project_id=r.project_id AND q.session_id=r.session_id AND q.rank=0 AND q.created_at=e.created_at AND q.event_id=r.event_id
        AND q.failure IS NULL AND NOT EXISTS (SELECT 1 FROM json_each(?4)
          WHERE json_extract(value,'$.e')=q.event_id AND json_extract(value,'$.failure') IS NOT NULL)
        ORDER BY q.created_at,q.event_id LIMIT 1) wait
      FROM json_each(?3) j WHERE NOT EXISTS (SELECT 1 FROM session_prompts p
        WHERE p.project_id=?1 AND p.session_id=?2 AND p.generation=?5 AND p.prompt_id=j.value))
      SELECT id,json_extract(wait,'$.e') event_id,json_extract(wait,'$.retry') retry FROM held`)
      .bind(this.projectId, this.sessionId, JSON.stringify(ids), JSON.stringify(outcomes), this.doc.generation)
      .all<{ id: string; event_id: string | null; retry: number | null }>()).results;
    this.batch.calls += Number(ids.length > 0);
    const pending = new Map(held.flatMap(row => row.event_id === null || row.retry === null ? [] : [[row.id, { eventId: row.event_id, retry: row.retry }] as const]));
    const heads = rows.flatMap(row => {
      const id = row.record === null ? null : parentOf(row.record), parent = typeof id === 'string' ? pending.get(id) : undefined;
      return parent === undefined ? [] : [{ head: row.consumed.e, start: parent.eventId }];
    });
    const cyclic = await this.cyclicQueued(heads, outcomes);
    const prompts = new Map<string, DocRecord>();
    for (const { record } of rows) if (record?.k === 'prompt' && !prompts.has(record.id)) prompts.set(record.id, record);
    const waitingFor = (id: string, head: string, seen = new Set<string>()): { eventId: string; retry: number } | null => {
      if (cyclic.has(head) || this.placedPrompts.has(id) || !pending.has(id) || seen.has(id)) return null;
      const prompt = prompts.get(id);
      if (prompt === undefined) return { ...pending.get(id)!, retry: Math.max(this.now + PUBLISH_BACKOFF_MIN_MS, pending.get(id)!.retry) };
      const parent = parentOf(prompt);
      if (typeof parent !== 'string') return null;
      seen.add(id);
      return waitingFor(parent, head, seen);
    };
    const defer = (row: QueuedRecord, retry: number, cause: QueuedWaitCause): QueuedRecord => ({ consumed: row.consumed, record: null,
      failure: { ...row.consumed, failure: null, retry, code: 'prompt_pending', cause } });
    const dependencies = (row: QueuedRecord): QueuedRecord => {
      const id = row.record === null ? null : parentOf(row.record);
      const wait = typeof id === 'string' ? waitingFor(id, row.consumed.e) : null;
      return wait === null ? row : defer(row, wait.retry, { kind: 'prompt', eventId: wait.eventId });
    };
    let ready = rows.map(dependencies);
    if (!ready.some(row => independent(row.record))) return ready;
    const skipped = [...this.consumed.filter(row => row.r === 0).map(row => row.e),
      ...rows.flatMap(row => row.record?.k === 'prompt' ? [row.consumed.e] : [])];
    const outside = await this.db.prepare(`SELECT q.created_at c,q.event_id e,COALESCE(
        (SELECT json_extract(value,'$.retry') FROM json_each(?4) WHERE json_extract(value,'$.e')=q.event_id),q.retry_at) retry
      FROM publish_queue q WHERE q.project_id=?1 AND q.session_id=?2 AND q.rank=0 AND q.failure IS NULL
        AND json_extract(q.retry_cause,'$.kind')='read' AND json_extract(q.retry_cause,'$.parentId') IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(?3) WHERE value=q.event_id)
        AND NOT EXISTS (SELECT 1 FROM json_each(?4) WHERE json_extract(value,'$.e')=q.event_id
          AND (json_extract(value,'$.failure') IS NOT NULL OR json_extract(value,'$.cause.kind') IS NOT 'read' OR json_extract(value,'$.cause.parentId') IS NOT NULL))
      ORDER BY q.created_at,q.event_id LIMIT 1`)
      .bind(this.projectId, this.sessionId, JSON.stringify(skipped), JSON.stringify(outcomes))
      .first<{ c: number; e: string; retry: number }>();
    this.batch.calls += 1;
    const roots = faults.flatMap(row => row.r === 0 && row.cause?.kind === 'read' && row.cause.parentId === null
      ? [{ c: row.c, e: row.e, retry: row.retry }] : []);
    const earlier = (left: Pick<QueuedRef, 'c' | 'e'>, right: Pick<QueuedRef, 'c' | 'e'>) => left.c < right.c || (left.c === right.c && left.e < right.e);
    const first = [...(outside === null ? [] : [outside]), ...roots]
      .reduce<{ c: number; e: string; retry: number } | null>((first, row) => first === null || earlier(row, first) ? row : first, null);
    if (first === null) return ready;
    const retry = first.retry > this.now ? first.retry : this.now + PUBLISH_BACKOFF_MIN_MS;
    const ordered = ready.map(row => independent(row.record) && earlier(first, row.consumed)
      ? defer(row, retry, { kind: 'order', eventId: first.e }) : row);
    const readyPrompts = new Set(ordered.flatMap(row => row.record?.k === 'prompt' ? [row.record.id] : []));
    for (const [index, row] of ordered.entries()) {
      const original = rows[index]!.record;
      if (original?.k === 'prompt' && row.failure?.failure === null && !readyPrompts.has(original.id)) {
        prompts.delete(original.id);
        pending.set(original.id, { eventId: row.consumed.e, retry: row.failure.retry });
      }
    }
    ready = ordered.map(dependencies);
    return ready;
  }

  /** The guard and frontier statements a publication commits around the batch's catalog writes. */
  private frontier(versions: readonly ChunkVersion[]): { before: PreparedStatement[]; after: PreparedStatement[] } {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const publications = this.publications.filter((publication) => publication.changed);
    const expectedOffsets = publications.map((publication) => ({ t: publication.transcript.transcript_id, o: publication.held }));
    const consumed = JSON.stringify(this.consumed);
    const settled = JSON.stringify([...this.consumed, ...this.failedQueued].map(({ r, c, e, t, w }) => ({ r, c, e, t, w })));
    const before = contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=? AND next_chunk=?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
          AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN transcript_publication t ON t.project_id=? AND t.generation=?
          AND t.transcript_id=json_extract(j.value,'$.t') WHERE t.published_offset IS NOT json_extract(j.value,'$.o'))
        AND (SELECT COUNT(*) FROM json_each(?) j JOIN publish_queue q ON q.project_id=? AND q.session_id=? AND q.rank=json_extract(j.value,'$.r')
          AND q.created_at=json_extract(j.value,'$.c') AND q.event_id=json_extract(j.value,'$.e')
          AND q.failure IS NULL AND q.retry_at=json_extract(j.value,'$.t') AND q.retry_cause IS json_extract(j.value,'$.w'))=?`,
      [p, s, g, this.doc.next_chunk, this.batch.expectedChunks(versions), p, s, g, JSON.stringify(expectedOffsets), p, g,
        settled, p, s, this.consumed.length + this.failedQueued.length]);
    const after: PreparedStatement[] = [];
    if (publications.length > 0) after.push(publicationStatement(db, p, s, g, this.now, publications.map((pub) => ({
      t: pub.transcript.transcript_id, o: pub.offset, l: pub.segmentLines, p: pub.openPromptId, u: pub.unfinished, r: pub.replyUnfinished,
      a: pub.replyLatestAt, ps: pub.promptScheme, rs: pub.recordScheme, s: pub.state, f: pub.failure, w: pub.awaitedSize,
      n: pub.placedRecords, d: pub.placedDigest, diag: pub.diagnostic===undefined?null:JSON.stringify(pub.diagnostic),
    }))));
    if (this.consumed.length > 0) {
      after.push(db.prepare(`DELETE FROM publish_queue WHERE (project_id,session_id,rank,created_at,event_id) IN
          (SELECT ?,?,json_extract(value,'$.r'),json_extract(value,'$.c'),json_extract(value,'$.e') FROM json_each(?))`)
        .bind(p, s, consumed));
    }
    if (this.failedQueued.length > 0) after.push(db.prepare(`UPDATE publish_queue SET
        failure=(SELECT json_extract(value,'$.failure') FROM json_each(?3) WHERE json_extract(value,'$.e')=publish_queue.event_id),
        retry_at=(SELECT json_extract(value,'$.retry') FROM json_each(?3) WHERE json_extract(value,'$.e')=publish_queue.event_id),
        retry_cause=(SELECT json_extract(value,'$.cause') FROM json_each(?3) WHERE json_extract(value,'$.e')=publish_queue.event_id)
      WHERE project_id=?1 AND session_id=?2 AND event_id IN (SELECT json_extract(value,'$.e') FROM json_each(?3))`)
      .bind(p, s, JSON.stringify(this.failedQueued.map(({ e, failure, retry, cause }) => ({ e, failure, retry, cause })))));
    const sizes = Object.fromEntries(this.publications.map((pub) => [pub.transcript.transcript_id, pub.transcript.size]));
    const behind = this.publications.some((pub) => pub.state === 'active' && pub.fault === undefined && pub.offset < pub.transcript.size);
    const laterDue = [
      ...this.publications.filter((pub) => pub.state !== 'failed' && pub.fault === undefined && pub.unfinished === 1)
        .map((pub) => pub.transcript.last_received_at + TRANSCRIPT_IDLE_MS),
      ...this.publications.filter((pub) => pub.fault !== undefined).map((pub) => this.faultDue(pub)),
    ];
    const dueAt = behind || this.more ? 0 : laterDue.length === 0 ? null : Math.min(...laterDue);
    const set = this.batch.documentSet(this.now);
    after.push(db.prepare(`UPDATE session_documents SET ${set.sql},
        due_at=CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id=? AND t.session_id=?
          AND t.size IS NOT json_extract(?, '$."' || t.transcript_id || '"'))
          THEN 0 ELSE (SELECT MIN(due) FROM (SELECT ? due UNION ALL
            SELECT MIN(retry_at) FROM publish_queue WHERE project_id=? AND session_id=? AND failure IS NULL)) END
      WHERE project_id=? AND session_id=?`)
      .bind(...set.params, p, s, JSON.stringify(sizes), dueAt, p, s, p, s));
    return { before, after };
  }
}
