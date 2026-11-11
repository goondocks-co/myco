import { PublicationOwnershipBuilding } from '../db/documents/ownership.js';
/**
 * The session document publisher.
 *
 * It keeps its own progress and shares none with the other transcript writers: a `transcript_publication` row per
 * transcript holds its offset and identity policy, keyed metadata shards hold each transcript's parser
 * continuation, and `publish_queue` holds the member events not yet published. A due session is read from those
 * frontiers, parsed with the common parser under the recorded policy, merged with its queued events, and written as
 * new chunk versions that one guarded batch makes live together with the catalog rows that describe them.
 *
 * The imported and non-imported capture arms of `document_due` select bounded session pages. Each pass opens the active tail
 * and advances a persisted transcript directory cursor; new input restarts that cursor by session key.
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
import type { ContentStore, RelationalStore, ServerEnv } from '../core/adapters.js';
import type { Bound } from '../db/index.js';
import { bundleContentEnv } from '../core/archive-bundle.js';
import { eventContent } from '../core/event-content.js';
import { emit } from '../telemetry.js';
import { sha256Hex } from '../hash.js';
import { BACKLOG_CHAINED_WAKE_MS } from '../core/tick.js';
import { type DocRecord } from '../content/document.js';
import { documentRecord } from '../content/document-records.js';
import { openPublication, publicationTranscripts, PUBLICATION_QUEUE_PAGE as PUBLISH_QUEUE_PER_PASS, type DocumentRow, type TranscriptRow, type QueuedRow } from '../db/documents/open.js';
import {
  commitAdmitted, DocumentBatch, DocumentPassFull, PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, publicationStatement,
  releaseHolders, reserveReached, type ChunkVersion,
} from './document-batch.js';
import { repairPublicationMetadata } from '../db/documents/metadata-catchup.js';
import { liveGenerationHolderGuard, retiredHoldersDue } from '../db/documents/retired-holders.js';
import {
  PublicationDependenciesBuilding, clearDependenciesStatement, consumeQueuedStatement, continueWakeStatement, earliestReadRoot, heldPrerequisites, holdQueuedStatement,
  recordDependenciesStatement, releasedDependents, wakeDependentsStatement,
} from '../db/documents/dependencies.js';
import { dueSessions, deferFailedPublication, settlePublication, publicationGuard, PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS, type DueSession } from '../db/documents/publication.js';
import { recordDocumentPublishFailure } from '../core/attention-state.js';
import { settleCards } from './card-settle.js';
import { locatePrompts } from './document-locators.js';
import {
  parseOnce, terminalRule, TRANSCRIPT_IDLE_MS, TRANSCRIPT_PARSE_SEGMENTS_PER_READ, type ParsePersistence, type ParseTarget, type PassLimits,
} from './parse.js';
import { promptOwners, type ParserState } from './parsers/index.js';
import { admittedDocumentEvent, sourceReceipts, RecordRefused, type PublicationRefusal } from './document-admission.js';
import { DOCUMENT_TEXT_FIELDS, documentText } from './document-text.js';
import { UnknownPluginFormat } from './parsers/plugin-events.js';
import { isPromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

/** Sessions one wake publishes. */
const PUBLISH_SESSIONS_PER_WAKE = 4;
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
  view_source_receipt_absent: 'receipt_absent',
  view_parser_absent: 'parser_absent',
  content_text_invalid: 'content_text_invalid',
  document_event_payload_invalid: 'document_event_payload_invalid',
};
/** Stops that can clear on the same bytes. A publication holding one, however it came to, is retried. */
const CLEARABLE_FAILURES: ReadonlySet<string | null> = new Set(['blob_absent', 'receipt_absent']);
function publicationOutcome(error: unknown): { failure: string; terminal: boolean; propagate: boolean; subreason?: PublicationRefusal } {
  const declared = error instanceof Error && Object.hasOwn(PUBLISH_FAILURES, error.message) ? PUBLISH_FAILURES[error.message] : undefined;
  const known = error instanceof UnknownPluginFormat ? 'format_unsupported'
    : error instanceof RecordRefused ? 'event_refused' : declared;
  const failure = known ?? namedFailure(error) ?? 'publication_failed';
  const subreason = error instanceof RecordRefused ? error.subreason : undefined;
  return { failure, subreason, terminal: known !== undefined && !CLEARABLE_FAILURES.has(failure), propagate: known === undefined && namedFailure(error) === undefined };
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
      if (error instanceof PublicationDependenciesBuilding) {
        emit({ kind: 'document_publication_dependencies_building', projectId: ref.project_id, sessionId: ref.session_id });
        await deferFailedPublication(env.db, ref, now);
        continue;
      }
      if (error instanceof PublicationOwnershipBuilding) {
        emit({kind:'document_publication_building',projectId:ref.project_id,sessionId:ref.session_id});
        const repaired=error.failure!==null&&await repairPublicationMetadata(env.db,env.blobs,ref.project_id,ref.session_id,now).catch(()=>{
          emit({kind:'document_metadata_repair_failed',projectId:ref.project_id,sessionId:ref.session_id});
          return false;
        });
        if(error.failure!==null&&!repaired)await deferFailedPublication(env.db,ref,now);
        more=true; continue;
      }
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
async function retireSupersededObjects(db: RelationalStore, now: number): Promise<number> {
  const rows = await retiredHoldersDue(db, now - RETIRED_OBJECT_GRACE_MS, RETIRE_PAGE);
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
type QueuedWaitCause = { kind: 'read'; parentId: string | null } | { kind: 'prompt'; eventId: string; promptId: string } | { kind: 'order'; eventId: string };
interface QueuedFailure extends QueuedRef { failure: string | null; retry: number; code: string; cause: QueuedWaitCause | null; error?: unknown }
interface QueuedRecord { consumed: QueuedRef; record: DocRecord | null; failure?: QueuedFailure }
interface DependencyRow { e: string; r: number; c: number; k: string; p: string; h: string | null }
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
  private after: string | null = null;
  private scanDue: number | null = null;
  private readonly directorySettled = new Set<string>();

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
    const { docs, queued, translationPending } = await openPublication(db, this.projectId, this.sessionId, this.now);
    const doc = docs[0];
    if (doc === undefined) return { records: 0, more: false };
    if (translationPending) throw new PublicationDependenciesBuilding();
    this.doc = doc;
    this.batch = new DocumentBatch(this.env, this.projectId, this.sessionId, doc);
    this.batch.calls += 1;
    await this.batch.open();
    this.batch.admitted = true;
    let cursor = doc.publication_after;
    if (cursor !== null) {
      const held = JSON.parse(cursor) as unknown[];
      if (held[3] !== doc.ended_at || held[4] !== doc.working_since || held[5] !== doc.last_turn_end_at) cursor = null;
    }
    this.scanDue = cursor === null ? null : doc.publication_scan_due;
    for (;;) {
      if (this.spent()) { this.more = true; break; }
      const transcripts = await publicationTranscripts(db, this.projectId, this.sessionId, doc.generation, cursor);
      this.batch.calls += 2;
      if (transcripts.length === 0) { cursor = null; break; }
      for (const t of transcripts) {
        if (this.spent()) { this.more = true; break; }
        const cleared = t.state === 'failed' && CLEARABLE_FAILURES.has(t.failure);
        const publication: Publication = {
          transcript: t, held: t.published_offset, offset: t.published_offset ?? 0, segmentLines: t.segment_lines ?? 0,
          openPromptId: t.open_prompt_id, unfinished: t.unfinished ?? 0, replyUnfinished: t.reply_unfinished ?? 0,
          replyLatestAt: t.reply_latest_at, promptScheme: t.prompt_scheme,
          recordScheme: t.record_scheme!, state: (cleared ? 'active' : t.state ?? 'active') as Publication['state'],
          diagnostic: cleared || t.diagnostic===null ? undefined : JSON.parse(t.diagnostic), failure: cleared ? null : t.failure, awaitedSize: t.awaited_size, placedRecords: t.placed_records, placedDigest: t.placed_digest,
          changed: cleared || t.published_offset === null,
        };
        this.publications.push(publication);
        await this.publishTranscript(publication);
        if (this.more || this.full || (publication.state === 'active' && publication.fault === undefined && publication.offset < t.size)) {
          this.more = true;
          break;
        }
        this.directorySettled.add(t.transcript_id);
        cursor = JSON.stringify([t.priority, t.first_received_at, t.transcript_id, doc.ended_at, doc.working_since, doc.last_turn_end_at]);
      }
      if (this.more) break;
    }
    this.after = cursor;
    await this.publishQueued(queued);
    const placed = this.batch.writer.changed || this.continuationChanged || this.consumed.length > 0 || this.failedQueued.length > 0 || this.batch.writer.sealing().length > 0;
    if (leads && this.full && !placed) throw new Error('document_pass_unaffordable');
    const written = await this.batch.commit(this.batch.writer.changed || this.continuationChanged, 'live', this.now, (version) =>
      liveGenerationHolderGuard(this.projectId, this.sessionId, doc.generation, version.key, version.sourceId), (versions) => this.frontier(versions));
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
    await this.batch.writer.readState(t.transcript_id);
    if (publication.offset === 0 || t.publication_parser_version === 0) this.batch.writer.states.delete(t.transcript_id);
    const receipts = new Map<number, number>();
    const claims = new Map<string, { thread: string; record: string }>();
    const persistence: ParsePersistence = {
      sourceTimes: (offsets) => sourceReceipts(this.db, this.projectId, t.transcript_id, offsets, receipts),
      checkpoint: async () => { throw new Error('document_continuation_chunked'); },
      owners: async (keys) => {
        await this.batch.writer.readOwners([...keys.keys()]);
        return promptOwners([...this.batch.writer.owners, ...[...claims].filter(([key]) => !this.batch.writer.owners.has(key))]);
      },
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
        const { failure, terminal, subreason } = publicationOutcome(error);
        if (!terminal) {
          if (!CLEARABLE_FAILURES.has(failure)) publication.faultError = error;
          this.recordFault(publication, failure);
          return;
        }
        Object.assign(publication, { state: 'failed', failure, changed: true,
          ...(subreason === undefined ? {} : { diagnostic: { branch: 'event_refused', offset: publication.offset, lineKind: 'unknown', subreason } }) });
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
    const retryOf = new Map(faults.map(row => [row.e, row.retry]));
    const terminal = faults.filter(row => row.failure !== null).map(row => row.e);
    const held = ids.length === 0 ? [] : await heldPrerequisites(this.db, this.projectId, this.sessionId, this.doc.generation, ids, terminal);
    this.batch.calls += Number(ids.length > 0);
    const released = await releasedDependents(this.db, this.projectId, rows.flatMap(row => row.consumed.w === null ? [] : [row.consumed.e]));
    this.batch.calls += Number(rows.some(row => row.consumed.w !== null));
    const pending = new Map(held.map(row => [row.id, { eventId: row.eventId, retry: retryOf.get(row.eventId) ?? row.retry }] as const));
    const prompts = new Map<string, DocRecord>();
    for (const { record } of rows) if (record?.k === 'prompt' && !prompts.has(record.id)) prompts.set(record.id, record);
    const waitingFor = (id: string, head: string, seen = new Set<string>()): { eventId: string; retry: number; promptId: string } | null => {
      if (released.has(head) || this.placedPrompts.has(id) || !pending.has(id) || seen.has(id)) return null;
      const prompt = prompts.get(id);
      if (prompt === undefined) return { ...pending.get(id)!, retry: Math.max(this.now + PUBLISH_BACKOFF_MIN_MS, pending.get(id)!.retry), promptId: id };
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
      return wait === null ? row : defer(row, wait.retry, { kind: 'prompt', eventId: wait.eventId, promptId: wait.promptId });
    };
    let ready = rows.map(dependencies);
    if (!ready.some(row => independent(row.record))) return ready;
    const excluded = [...this.consumed.filter(row => row.r === 0).map(row => row.e),
      ...rows.flatMap(row => row.record?.k === 'prompt' ? [row.consumed.e] : []), ...faults.map(row => row.e)];
    const outside = await earliestReadRoot(this.db, this.projectId, this.sessionId, excluded);
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

  /** The typed rows a deferral maintains: what each deferred event now waits on, and the read-faulted root prompts holding turn order. */
  private dependencyRows(): DependencyRow[] {
    return this.failedQueued.flatMap(({ e, r, c, failure, cause }): DependencyRow[] => {
      if (failure !== null || cause === null) return [];
      if (cause.kind === 'prompt') return [{ e, r, c, k: 'prompt', p: cause.promptId, h: cause.eventId }];
      if (cause.kind === 'order') return [{ e, r, c, k: 'event', p: cause.eventId, h: cause.eventId }];
      return r === 0 && cause.parentId === null ? [{ e, r, c, k: 'read', p: '', h: null }] : [];
    });
  }

  /** The guard and frontier statements a publication commits around the batch's catalog writes. */
  private frontier(versions: readonly ChunkVersion[]): { before: Bound[]; after: Bound[] } {
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const publications = this.publications.filter((publication) => publication.changed);
    const expectedOffsets = publications.map((publication) => ({ t: publication.transcript.transcript_id, o: publication.held }));
    const consumed = JSON.stringify(this.consumed);
    const settled = JSON.stringify([...this.consumed, ...this.failedQueued].map(({ r, c, e, t, w }) => ({ r, c, e, t, w })));
    const before = publicationGuard({ project: p, session: s, generation: g, nextChunk: this.doc.next_chunk,
      revision: this.doc.publication_input_revision, after: this.doc.publication_after, chunks: this.batch.expectedChunks(versions),
      offsets: JSON.stringify(expectedOffsets), queue: settled, queued: this.consumed.length + this.failedQueued.length });
    const after: Bound[] = [];
    if (publications.length > 0) after.push(publicationStatement(p, s, g, this.now, publications.map((pub) => ({
      t: pub.transcript.transcript_id, o: pub.offset, l: pub.segmentLines, p: pub.openPromptId, u: pub.unfinished, r: pub.replyUnfinished,
      a: pub.replyLatestAt, ps: pub.promptScheme, rs: pub.recordScheme, s: pub.state, f: pub.failure, w: pub.awaitedSize,
      n: pub.placedRecords, d: pub.placedDigest, diag: pub.diagnostic===undefined?null:JSON.stringify(pub.diagnostic),
    }))));
    if (this.consumed.length > 0) after.push(consumeQueuedStatement(p, s, consumed));
    const heldChildren = [...this.consumed, ...this.failedQueued].map(({ e }) => e);
    if (heldChildren.length > 0) after.push(clearDependenciesStatement(p, JSON.stringify(heldChildren)));
    if (this.failedQueued.length > 0) after.push(holdQueuedStatement(p, s, JSON.stringify(this.failedQueued.map(({ r, c, e, failure, retry, cause }) => ({ r, c, e, failure, retry, cause })))));
    const dependencies = this.dependencyRows();
    if (dependencies.length > 0) after.push(recordDependenciesStatement(p, s, this.now, JSON.stringify(dependencies)));
    const holders = [...new Set([...this.consumed.map(({ e }) => e), ...this.failedQueued.filter(row => row.failure !== null).map(({ e }) => e),
      ...(this.doc.publication_wake === null ? [] : JSON.parse(this.doc.publication_wake) as string[])])];
    if (holders.length > 0) after.push(wakeDependentsStatement(p, s, JSON.stringify(holders)));
    const behind = this.publications.some((pub) => pub.state === 'active' && pub.fault === undefined && pub.offset < pub.transcript.size);
    const laterDue = [
      ...(this.scanDue === null ? [] : [this.scanDue]),
      ...this.publications.filter((pub) => this.directorySettled.has(pub.transcript.transcript_id) && pub.state !== 'failed' && pub.fault === undefined && pub.unfinished === 1)
        .map((pub) => pub.transcript.last_received_at + TRANSCRIPT_IDLE_MS),
      ...this.publications.filter((pub) => this.directorySettled.has(pub.transcript.transcript_id) && pub.fault !== undefined).map((pub) => this.faultDue(pub)),
    ];
    const scanDue = laterDue.length === 0 ? null : Math.min(...laterDue);
    const dueAt = behind || this.more ? 0 : scanDue;
    after.push(this.batch.catalogStatement(this.now));
    after.push(settlePublication(p, s, this.after, this.after === null ? null : scanDue, dueAt));
    if (holders.length > 0) after.push(continueWakeStatement(p, s, JSON.stringify(holders)));
    return { before, after };
  }
}
