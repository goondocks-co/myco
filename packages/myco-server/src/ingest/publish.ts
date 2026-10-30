/**
 * The session document publisher.
 *
 * It keeps its own progress and shares none with the other transcript writers: a `transcript_publication` row per
 * transcript holds its offset and identity policy, the session's last page chunk holds each transcript's parser
 * continuation, and `publish_queue` holds the member events not yet published. A due session is read from those
 * frontiers, parsed with the common parser under the recorded policy, merged with its queued events, and written as
 * new chunk versions that one guarded batch makes live together with the catalog rows that describe them.
 *
 * A session is due when its `session_documents.due_at` has passed (a transcript grew, or an unfinished turn may now
 * close) or it has queued events. Only catalog rows decide that; the documents themselves are read only by a pass.
 */
import type { ContentStore, PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import { contentAssertion, prepareDerivedStream, readVerifiedContentText, type DerivedContentSource } from '../core/registered-content.js';
import { registeredBlobsGuard, releaseBlobs } from '../core/object-release.js';
import { blobObjectKey } from '../core/blob-objects.js';
import { remainingInvocationBudget } from '../core/content-budget.js';
import { trimTurn, type TurnInput } from '../core/turn-card-rules.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { emit } from '../telemetry.js';
import { PARSER_VERSION } from '../constants.js';
import { DOCUMENT_PREVIEW_CHARS } from '../db/document-tables.js';
import { BODY_ENCODING, encodePageChunk, PAGE_ENCODING, SESSION_OWNER, type DocRecord } from '../content/document.js';
import { documentRecord } from '../content/document-records.js';
import { chunkRowsSql, directoryOf, pageRowsSql, readPageChunk, type ChunkRow, type PageRow } from '../content/document-reader.js';
import { DocumentWriter, type DocumentLayout } from '../content/document-writer.js';
import { parseOnce, terminalRule, TRANSCRIPT_IDLE_MS, type ParsePersistence, type ParseTarget, type PassLimits } from './parse.js';
import { promptOwners, type ParserState } from './parsers/index.js';
import { admittedViewEvent, viewSourceReceipts } from './view-writer.js';
import { isPromptIdScheme, type PromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

/** Sessions one wake publishes. */
export const PUBLISH_SESSIONS_PER_WAKE = 4;
/** Queued member events one pass publishes. */
export const PUBLISH_QUEUE_PER_PASS = 200;
/** How long a superseded chunk version stays readable before its holder is retired. */
export const RETIRED_OBJECT_GRACE_MS = 15 * 60_000;
/** Distinct paths a session's tools touched that the catalog keeps. */
export const SESSION_PATHS_LIMIT = 500;
const RETIRE_PAGE = 100;
/** The record identity scheme a newly published transcript is minted under. */
const PUBLISHED_RECORD_SCHEME = 'source-record-v1';

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

/** The prompt scheme a transcript first published is minted under: the view mapping of its pinned scheme. */
export function publishedPromptScheme(pinned: unknown): PromptIdScheme | null {
  const mapped = pinned === 'offset-v1' ? 'offset-v2' : pinned === 'stamp-or-offset-v1' ? 'stamp-or-offset-v2' : pinned;
  return isPromptIdScheme(mapped) ? mapped : null;
}

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
interface QueuedRow { event_id: string; kind: string; payload: string; created_at: number; received_at: number }

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

/** The catalog half of one session: the sessions due, oldest first, selected without reading a document. */
async function dueSessions(db: RelationalStore, now: number, limit: number): Promise<{ project_id: string; session_id: string }[]> {
  return (await db.prepare(`SELECT project_id,session_id FROM (
      SELECT d.project_id,d.session_id,d.due_at at FROM session_documents d WHERE d.state='live' AND d.due_at<=?
      UNION SELECT q.project_id,q.session_id,MIN(q.queued_at) at FROM publish_queue q JOIN session_documents d
        ON d.project_id=q.project_id AND d.session_id=q.session_id AND d.state='live' GROUP BY q.project_id,q.session_id) due
    WHERE NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=due.project_id AND t.session_id=due.session_id)
    GROUP BY project_id,session_id ORDER BY MIN(at),project_id,session_id LIMIT ?`)
    .bind(now, limit).all<{ project_id: string; session_id: string }>()).results;
}

/** Publishes the due sessions within the wake's remaining budget, then retires superseded chunk versions past their grace. */
export async function publishDocuments(env: Pick<ServerEnv, 'db' | 'blobs'>, now: number, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const due = await dueSessions(env.db, now, PUBLISH_SESSIONS_PER_WAKE);
  let changed = 0;
  let more = due.length === PUBLISH_SESSIONS_PER_WAKE;
  let failure: unknown;
  for (const ref of due) {
    const remaining = remainingInvocationBudget(env.db);
    if (limits.clock() >= limits.deadline || (remaining !== null && (remaining.statements < 64 || remaining.blobCalls < 12))) {
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
  changed += await retireSupersededObjects(env.db, now);
  if (failure !== undefined) throw failure;
  return { changed, more };
}

/** Retires holders past their grace, with the proof rows registered under their own source, then decides their objects. */
export async function retireSupersededObjects(db: RelationalStore, now: number): Promise<number> {
  const rows = (await db.prepare(`SELECT project_id p,session_id s,blob_key k,source_id i FROM retired_objects
    WHERE retired_at<=? ORDER BY retired_at LIMIT ${RETIRE_PAGE}`).bind(now - RETIRED_OBJECT_GRACE_MS)
    .all<{ p: string; s: string; k: string; i: string }>()).results;
  if (rows.length === 0) return 0;
  const page = JSON.stringify(rows);
  await db.batch([
    db.prepare(`DELETE FROM registered_content_proofs WHERE source_kind='document' AND (project_id,key,source_id) IN
      (SELECT json_extract(value,'$.p'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`).bind(page),
    db.prepare(`DELETE FROM retired_objects WHERE (project_id,session_id,blob_key,source_id) IN
      (SELECT json_extract(value,'$.p'),json_extract(value,'$.s'),json_extract(value,'$.k'),json_extract(value,'$.i') FROM json_each(?))`).bind(page),
  ]);
  await releaseBlobs(db, rows.map((row) => ({ projectId: row.p, key: row.k })), now);
  return rows.length;
}

/** The body field a spilled payload `blob` holds for an event kind. */
const SPILLED_FIELD: Readonly<Record<string, string>> = { prompt: 'text', response: 'text', plan: 'content', 'tool.use': 'input', 'tool.failure': 'input' };

/** A queued event's payload with a spilled body read back into the field it stands for. */
async function hydratedPayload(env: ContentStore, projectId: string, row: QueuedRow): Promise<Record<string, unknown>> {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const field = SPILLED_FIELD[row.kind];
  if (field === undefined || typeof payload.blob !== 'string') return payload;
  const blob = await env.db.prepare('SELECT generation,size FROM blobs WHERE project_id=? AND key=?')
    .bind(projectId, payload.blob).first<{ generation: string | null; size: number }>();
  if (blob === null) throw new Error('document_event_body_missing');
  const text = await readVerifiedContentText(env, blobObjectKey(projectId, payload.blob, blob.generation), blob.size, payload.blob);
  const { blob: _spilled, ...rest } = payload;
  return { ...rest, [field]: field === 'input' ? JSON.parse(text) : text };
}

/** The turn a document's records describe, as the card rules read it. */
function turnInput(turnKey: string, records: readonly DocRecord[]): TurnInput | null {
  const prompt = records.find((record) => record.k === 'prompt' && record.id === turnKey);
  if (prompt === undefined) return null;
  const s = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    turnKey, origin: s(prompt.origin) || 'user', prompt: s(prompt.text),
    steering: records.filter((r) => r.k === 'prompt' && r.id !== turnKey).map((r) => ({ promptId: r.id, text: s(r.text) })),
    replies: records.filter((r) => r.k === 'reply').map((r) => ({ responseId: r.id, text: s(r.text) })),
    tools: records.filter((r) => r.k === 'tool').map((r) => ({
      toolCallId: r.id, toolName: s(r.tool_name), input: typeof r.input === 'string' ? r.input : null,
      output: typeof r.output_preview === 'string' ? r.output_preview : null, success: r.success === 1,
      errorMessage: typeof r.error_message === 'string' ? r.error_message : null,
    })),
    plans: records.filter((r) => r.k === 'plan').map((r) => ({
      planKey: r.id, title: typeof r.title === 'string' ? r.title : null, status: s(r.status), content: typeof r.content === 'string' ? r.content : null,
    })),
  };
}

const preview = (text: unknown): string | null =>
  typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, DOCUMENT_PREVIEW_CHARS) : null;

/** One pass over one session: its transcripts from their frontiers, then its queued events, committed together. */
class SessionPublication {
  private readonly db: RelationalStore;
  private readonly passId = crypto.randomUUID();
  private doc!: DocumentRow;
  private writer!: DocumentWriter;
  private publications: Publication[] = [];
  private consumed: string[] = [];
  private more = false;
  private calls = 0;
  private continuationChanged = false;
  /** Each prompt's turn key, null for a prompt no turn holds; absent when unknown. */
  private readonly turns = new Map<string, string | null>();
  private readonly resolved = new Set<string>();
  private readonly newPrompts: { record: DocRecord; turnKey: string | null }[] = [];
  private readonly counts = { prompts: 0, user_prompts: 0, replies: 0, tool_calls: 0, failed_tools: 0, plans: 0 };
  private readonly paths = new Map<string, { n: number; at: number }>();
  private readonly mycoCalls = new Map<string, DocRecord & { harness: string | null }>();
  private lastRecordAt: number | null = null;
  private openTurn: string | null = null;
  private firstPrompt: string | null = null;
  private records = 0;

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
    return this.calls >= this.limits.calls || this.limits.clock() >= this.limits.deadline;
  }

  async run(): Promise<{ records: number; more: boolean }> {
    const db = this.db;
    const generation = '(SELECT generation FROM session_documents WHERE project_id=?1 AND session_id=?2)';
    const [docs, chunks, pages, transcripts, queued] = await db.batch([
      db.prepare(`SELECT d.generation,d.next_chunk,d.first_prompt,d.open_turn_key,d.prompts,s.created_by_token_id token_id,
          s.ended_at,s.working_since,s.last_turn_end_at
        FROM session_documents d JOIN sessions s ON s.project_id=d.project_id AND s.session_id=d.session_id
        WHERE d.project_id=?1 AND d.session_id=?2 AND d.state='live' AND d.generation IS NOT NULL`).bind(this.projectId, this.sessionId),
      db.prepare(chunkRowsSql(generation)).bind(this.projectId, this.sessionId),
      db.prepare(pageRowsSql(generation)).bind(this.projectId, this.sessionId),
      db.prepare(`SELECT t.transcript_id,t.agent,t.role,t.size,t.machine_id,t.token_id,t.prompt_identity_scheme,t.imported_at,t.last_received_at,
          p.published_offset,p.segment_lines,p.open_prompt_id,p.unfinished,p.reply_unfinished,p.reply_latest_at,p.prompt_scheme,p.record_scheme,
          p.state,p.failure,p.awaited_size
        FROM transcripts t LEFT JOIN transcript_publication p ON p.project_id=t.project_id AND p.transcript_id=t.transcript_id AND p.generation=${generation}
        WHERE t.project_id=?1 AND t.session_id=?2 ORDER BY CASE t.role WHEN 'subagent' THEN 1 ELSE 0 END,t.first_received_at,t.transcript_id`)
        .bind(this.projectId, this.sessionId),
      db.prepare(`SELECT q.event_id,e.kind,e.payload,e.created_at,e.received_at FROM publish_queue q
        JOIN events e ON e.project_id=q.project_id AND e.event_id=q.event_id
        WHERE q.project_id=? AND q.session_id=? ORDER BY e.created_at,q.event_id LIMIT ${PUBLISH_QUEUE_PER_PASS}`)
        .bind(this.projectId, this.sessionId),
    ]);
    this.calls += 1;
    const doc = docs!.results[0] as DocumentRow | undefined;
    if (doc === undefined) return { records: 0, more: false };
    this.doc = doc;
    this.openTurn = doc.open_turn_key;
    this.firstPrompt = doc.first_prompt;
    this.writer = new DocumentWriter(directoryOf(doc.generation, chunks!.results as ChunkRow[], pages!.results as PageRow[]), doc.next_chunk,
      (row) => readPageChunk(this.env, row));
    await this.writer.open();
    this.publications = (transcripts!.results as TranscriptRow[]).map((t) => ({
      transcript: t, held: t.published_offset, offset: t.published_offset ?? 0, segmentLines: t.segment_lines ?? 0,
      openPromptId: t.open_prompt_id, unfinished: t.unfinished ?? 0, replyUnfinished: t.reply_unfinished ?? 0,
      replyLatestAt: t.reply_latest_at, promptScheme: t.published_offset === null ? publishedPromptScheme(t.prompt_identity_scheme) : t.prompt_scheme,
      recordScheme: t.record_scheme ?? PUBLISHED_RECORD_SCHEME, state: (t.state ?? 'active') as Publication['state'],
      failure: t.failure, awaitedSize: t.awaited_size, changed: t.published_offset === null,
    }));
    for (const publication of this.publications) await this.publishTranscript(publication);
    await this.publishQueued(queued!.results as QueuedRow[]);
    await this.commit();
    return { records: this.records, more: this.more };
  }

  private target(publication: Publication, persistence: ParsePersistence): ParseTarget {
    const t = publication.transcript;
    const context = this.writer.states.get(t.transcript_id) ?? null;
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
      owners: async () => promptOwners([...this.writer.owners, ...[...claims].filter(([key]) => !this.writer.owners.has(key))]),
      claim: async (incoming) => { for (const claim of incoming) claims.set(claim.key, { thread: claim.thread, record: claim.record }); },
      stop: async (failure) => { Object.assign(publication, { state: 'failed', failure, changed: true }); },
      awaitBytes: async () => { Object.assign(publication, { state: 'awaiting', awaitedSize: t.size, changed: true }); },
      header: async (metadata) => {
        this.writer.states.set(t.transcript_id, metadata);
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
        await this.place(records, t.agent);
        for (const [key, owner] of claims) if (!this.writer.owners.has(key)) this.writer.owners.set(key, owner);
        claims.clear();
        const state: ParserState = window.state;
        delete state.findings;
        delete state.unattributed;
        const unfinished = Object.keys(state.pending ?? {}).length > 0 || state.reply !== undefined ? 1 : 0;
        const replyLatestAt = state.reply?.parts.reduce((latest, part) => Math.max(latest, part.createdAt), 0) ?? null;
        this.writer.states.set(t.transcript_id, {
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
      const context = this.writer.states.get(t.transcript_id);
      if (publication.offset >= t.size) {
        if (publication.unfinished !== 1 || context?.mycoParserUnfinished !== 1) return;
        if (terminalRule(this.target(publication, persistence), this.now, this.limits) === undefined) return;
      }
      const from = publication.offset;
      const wasUnfinished = publication.unfinished;
      try {
        const report = await parseOnce(this.env, this.target(publication, persistence), this.now, {
          ...this.limits, calls: Math.max(1, this.limits.calls - this.calls),
        });
        this.calls += report.calls;
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
    for (const row of rows) {
      if (this.spent()) { this.more = true; break; }
      const payload = await hydratedPayload(this.env, this.projectId, row);
      const record = documentRecord(row.kind, payload, row.created_at, { ev: row.event_id, received_at: row.received_at });
      if (record !== null) records.push(record);
      this.consumed.push(row.event_id);
    }
    await this.place(records, null);
  }

  /** Reads the turn of every prompt these records name that this pass has not resolved yet. */
  private async resolve(records: readonly DocRecord[]): Promise<void> {
    const wanted = [...new Set(records.flatMap((record) => {
      const id = record.k === 'prompt' ? record.parent_prompt_id : record.prompt_id;
      return typeof id === 'string' && !this.resolved.has(id) && !this.turns.has(id) ? [id] : [];
    }))];
    if (wanted.length === 0) return;
    const held = (await this.db.prepare(`SELECT prompt_id,turn_key FROM session_prompts WHERE project_id=? AND session_id=? AND generation=?
      AND prompt_id IN (SELECT value FROM json_each(?))`).bind(this.projectId, this.sessionId, this.doc.generation, JSON.stringify(wanted))
      .all<{ prompt_id: string; turn_key: string | null }>()).results;
    this.calls += 1;
    for (const row of held) this.turns.set(row.prompt_id, row.turn_key);
    for (const id of wanted) this.resolved.add(id);
  }

  /** The owner of a record: its prompt's turn, or the session for a record no turn holds. */
  private ownerOf(record: DocRecord): string {
    if (record.k === 'prompt') {
      const parent = typeof record.parent_prompt_id === 'string' ? record.parent_prompt_id : null;
      const turn = this.turns.has(record.id) ? this.turns.get(record.id)! : parent === null ? record.id : (this.turns.get(parent) ?? null);
      this.turns.set(record.id, turn);
      return turn ?? SESSION_OWNER;
    }
    return (record.prompt_id === null ? null : this.turns.get(record.prompt_id)) ?? SESSION_OWNER;
  }

  private async place(records: readonly DocRecord[], harness: string | null): Promise<void> {
    await this.resolve(records);
    const reads = this.writer.reads;
    for (const record of records) {
      const owner = this.ownerOf(record);
      const placed = await this.writer.upsert(record, owner);
      if (placed.outcome === 'unchanged') continue;
      this.records += 1;
      this.lastRecordAt = Math.max(this.lastRecordAt ?? 0, record.created_at);
      if (record.k === 'tool' && typeof placed.record.myco_tool === 'string') this.mycoCalls.set(record.id, { ...placed.record, harness });
      if (placed.outcome === 'merged') {
        if (record.k === 'tool') this.counts.failed_tools += (placed.record.success === 0 ? 1 : 0) - (placed.held.success === 0 ? 1 : 0);
        continue;
      }
      if (record.k === 'prompt') {
        this.counts.prompts += 1;
        if (record.origin === 'user') this.counts.user_prompts += 1;
        const turnKey = owner === SESSION_OWNER ? null : owner;
        this.newPrompts.push({ record, turnKey });
        if (turnKey === record.id) {
          this.openTurn = record.id;
          if (this.firstPrompt === null && record.origin === 'user') this.firstPrompt = preview(record.text);
        }
      } else if (record.k === 'reply') this.counts.replies += 1;
      else if (record.k === 'plan') this.counts.plans += 1;
      else {
        this.counts.tool_calls += 1;
        if (record.success === 0) this.counts.failed_tools += 1;
        for (const path of Array.isArray(record.files_affected) ? record.files_affected : []) {
          if (typeof path !== 'string') continue;
          const held = this.paths.get(path);
          this.paths.set(path, { n: (held?.n ?? 0) + 1, at: Math.max(held?.at ?? 0, record.created_at) });
        }
      }
    }
    this.calls += this.writer.reads - reads;
  }

  /** The summary and card input hash of every turn this pass changed, read from its pages. */
  private async settledTurns(): Promise<Record<string, unknown>[]> {
    const settled: Record<string, unknown>[] = [];
    for (const owner of this.writer.touched) {
      if (owner === SESSION_OWNER) continue;
      const records = (await this.writer.pagesOf(owner)).flatMap((page) => page.records);
      const input = turnInput(owner, records);
      if (input === null) continue;
      const trimmed = trimTurn(input);
      const prompt = records.find((record) => record.k === 'prompt' && record.id === owner)!;
      settled.push({
        id: owner, preview: preview(prompt.text), text_chars: typeof prompt.text === 'string' ? prompt.text.length : 0,
        tools: input.tools.length, replies: input.replies.length, children: input.steering.length, plans: input.plans.length,
        input_hash: await sha256Hex(trimmed.text), input_chars: trimmed.text.length,
      });
    }
    return settled;
  }

  /** Writes and registers every chunk version, then makes them live with the catalog in one guarded batch. */
  private async commit(): Promise<void> {
    const db = this.db;
    const changedPublications = this.publications.filter((publication) => publication.changed);
    const writes = this.writer.changed || this.continuationChanged;
    const layout: DocumentLayout | null = writes ? this.writer.layout() : null;
    const settled = writes ? await this.settledTurns() : [];
    const registered: { chunkNo: number; key: string; bytes: number; kind: 'page' | 'body'; encoding: string; sourceId: string; previous?: ChunkRow }[] = [];
    try {
      if (layout !== null) await this.register(layout, registered);
      await db.batch(this.commitStatements(layout, registered, settled, changedPublications));
    } catch (error) {
      if (registered.length > 0) await this.abandon(registered);
      throw error;
    }
    if (layout !== null) emit({ kind: 'document_published', projectId: this.projectId, sessionId: this.sessionId, records: this.records, chunks: registered.length });
  }

  private source(sourceId: string): DerivedContentSource {
    return {
      projectId: this.projectId, sessionId: this.sessionId, eventId: sourceId, tokenId: this.doc.token_id, envelopeHash: sourceId,
      sourceKind: 'document', resourceId: sourceId,
    };
  }

  private async register(layout: DocumentLayout, registered: { chunkNo: number; key: string; bytes: number; kind: 'page' | 'body'; encoding: string; sourceId: string; previous?: ChunkRow }[]): Promise<void> {
    const guard = {
      sql: `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=?)`,
      params: [this.projectId, this.sessionId, this.doc.generation],
    };
    const put = async (chunkNo: number, bytes: Uint8Array<ArrayBuffer>, kind: 'page' | 'body', encoding: string, previous?: ChunkRow) => {
      const digest = await sha256HexOf(bytes);
      const sourceId = `doc:${this.sessionId}:${this.doc.generation}:${chunkNo}:${this.passId}`;
      const content = await prepareDerivedStream(this.env, this.source(sourceId), {
        size: bytes.byteLength, digest, stream: () => new Blob([bytes]).stream(),
      }, this.now, guard);
      this.calls += 4;
      registered.push({ chunkNo, key: content.key, bytes: bytes.byteLength, kind, encoding, sourceId, ...(previous ? { previous } : {}) });
      return digest;
    };
    for (const body of layout.bodyChunks) body.ref.digest = await put(body.chunkNo, utf8(body.text), 'body', BODY_ENCODING);
    for (const write of layout.pageChunks) await put(write.chunkNo, await encodePageChunk(write.chunk) as Uint8Array<ArrayBuffer>, 'page', PAGE_ENCODING, write.previous);
  }

  /** Releases what a pass registered and never made live. */
  private async abandon(registered: readonly { key: string; sourceId: string }[]): Promise<void> {
    await this.db.prepare(`DELETE FROM registered_content_proofs WHERE project_id=? AND source_kind='document' AND source_id IN (SELECT value FROM json_each(?))`)
      .bind(this.projectId, JSON.stringify(registered.map((row) => row.sourceId))).run();
    await releaseBlobs(this.db, registered.map((row) => ({ projectId: this.projectId, key: row.key })), this.now);
  }

  private commitStatements(
    layout: DocumentLayout | null,
    registered: readonly { chunkNo: number; key: string; bytes: number; kind: 'page' | 'body'; encoding: string; sourceId: string; previous?: ChunkRow }[],
    settled: readonly Record<string, unknown>[],
    publications: readonly Publication[],
  ): PreparedStatement[] {
    const db = this.db;
    const p = this.projectId, s = this.sessionId, g = this.doc.generation;
    const expectedChunks = registered.map((row) => ({ n: row.chunkNo, k: row.previous?.blob_key ?? null }));
    const expectedOffsets = publications.map((publication) => ({ t: publication.transcript.transcript_id, o: publication.held }));
    const statements: PreparedStatement[] = [
      ...contentAssertion(db, `EXISTS (SELECT 1 FROM session_documents WHERE project_id=? AND session_id=? AND state='live' AND generation=? AND next_chunk=?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN session_chunks c ON c.project_id=? AND c.session_id=? AND c.generation=?
          AND c.chunk_no=json_extract(j.value,'$.n') WHERE c.blob_key IS NOT json_extract(j.value,'$.k'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN transcript_publication t ON t.project_id=? AND t.generation=?
          AND t.transcript_id=json_extract(j.value,'$.t') WHERE t.published_offset IS NOT json_extract(j.value,'$.o'))
        AND (SELECT COUNT(*) FROM publish_queue WHERE project_id=? AND session_id=? AND event_id IN (SELECT value FROM json_each(?)))=?`,
      [p, s, g, this.doc.next_chunk, JSON.stringify(expectedChunks), p, s, g, JSON.stringify(expectedOffsets), p, g,
        p, s, JSON.stringify(this.consumed), this.consumed.length]),
    ];
    if (registered.length > 0) {
      const rows = JSON.stringify(registered.map((row) => ({ n: row.chunkNo, k: row.key, b: row.bytes, d: row.kind, e: row.encoding, i: row.sourceId })));
      statements.push(
        registeredBlobsGuard(db, registered.map((row) => ({ projectId: p, key: row.key }))),
        db.prepare(`INSERT OR IGNORE INTO retired_objects (project_id,session_id,blob_key,source_id,retired_at)
          SELECT c.project_id,c.session_id,c.blob_key,c.source_id,? FROM json_each(?) j JOIN session_chunks c
            ON c.project_id=? AND c.session_id=? AND c.generation=? AND c.chunk_no=json_extract(j.value,'$.n')`)
          .bind(this.now, rows, p, s, g),
        db.prepare(`INSERT INTO session_chunks (project_id,session_id,generation,chunk_no,blob_key,kind,encoding,bytes,source_id,state)
          SELECT ?,?,?,json_extract(value,'$.n'),json_extract(value,'$.k'),json_extract(value,'$.d'),json_extract(value,'$.e'),
            json_extract(value,'$.b'),json_extract(value,'$.i'),'live' FROM json_each(?) WHERE true
          ON CONFLICT (project_id,session_id,generation,chunk_no) DO UPDATE SET blob_key=excluded.blob_key,kind=excluded.kind,
            encoding=excluded.encoding,bytes=excluded.bytes,source_id=excluded.source_id,state=excluded.state`)
          .bind(p, s, g, rows),
      );
    }
    if (layout !== null && layout.pages.length > 0) {
      statements.push(db.prepare(`INSERT INTO session_pages (project_id,session_id,generation,owner,page,chunk_no,records,bytes)
        SELECT ?,?,?,json_extract(value,'$.owner'),json_extract(value,'$.page'),json_extract(value,'$.chunkNo'),
          json_extract(value,'$.records'),json_extract(value,'$.bytes') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,owner,page) DO UPDATE SET chunk_no=excluded.chunk_no,records=excluded.records,bytes=excluded.bytes`)
        .bind(p, s, g, JSON.stringify(layout.pages)));
    }
    if (publications.length > 0) {
      statements.push(db.prepare(`INSERT INTO transcript_publication (project_id,transcript_id,generation,session_id,published_offset,segment_lines,
          open_prompt_id,unfinished,reply_unfinished,reply_latest_at,prompt_scheme,record_scheme,parser_version,state,failure,awaited_size,updated_at)
        SELECT ?,json_extract(value,'$.t'),?,?,json_extract(value,'$.o'),json_extract(value,'$.l'),json_extract(value,'$.p'),json_extract(value,'$.u'),
          json_extract(value,'$.r'),json_extract(value,'$.a'),json_extract(value,'$.ps'),json_extract(value,'$.rs'),?,json_extract(value,'$.s'),
          json_extract(value,'$.f'),json_extract(value,'$.w'),? FROM json_each(?) WHERE true
        ON CONFLICT (project_id,transcript_id,generation) DO UPDATE SET published_offset=excluded.published_offset,segment_lines=excluded.segment_lines,
          open_prompt_id=excluded.open_prompt_id,unfinished=excluded.unfinished,reply_unfinished=excluded.reply_unfinished,
          reply_latest_at=excluded.reply_latest_at,parser_version=excluded.parser_version,state=excluded.state,failure=excluded.failure,
          awaited_size=excluded.awaited_size,updated_at=excluded.updated_at`)
        .bind(p, g, s, PARSER_VERSION, this.now, JSON.stringify(publications.map((pub) => ({
          t: pub.transcript.transcript_id, o: pub.offset, l: pub.segmentLines, p: pub.openPromptId, u: pub.unfinished, r: pub.replyUnfinished,
          a: pub.replyLatestAt, ps: pub.promptScheme, rs: pub.recordScheme, s: pub.state, f: pub.failure, w: pub.awaitedSize,
        })))));
    }
    if (this.newPrompts.length > 0) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO session_prompts (project_id,session_id,generation,prompt_id,turn_key,parent_hint,ord,origin,
          prompt_kind,thread_label,created_at,claim,source_key,prompt_key_hash,preview,text_chars)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.turn'),json_extract(value,'$.parent'),?+key,json_extract(value,'$.origin'),
          json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.at'),json_extract(value,'$.claim'),
          json_extract(value,'$.source'),json_extract(value,'$.hash'),json_extract(value,'$.preview'),json_extract(value,'$.chars') FROM json_each(?)`)
        .bind(p, s, g, this.doc.prompts, JSON.stringify(this.newPrompts.map(({ record, turnKey }) => ({
          id: record.id, turn: turnKey, parent: record.parent_prompt_id ?? null, origin: record.origin ?? null, kind: record.prompt_kind ?? null,
          label: record.thread_label ?? null, at: record.created_at, claim: record.claim ?? null, source: record.source_key ?? null,
          hash: record.prompt_key_hash ?? null, preview: preview(record.text), chars: typeof record.text === 'string' ? record.text.length : 0,
        })))));
    }
    if (settled.length > 0) {
      statements.push(db.prepare(`UPDATE session_prompts SET preview=json_extract(j.value,'$.preview'),text_chars=json_extract(j.value,'$.text_chars'),
          tools=json_extract(j.value,'$.tools'),replies=json_extract(j.value,'$.replies'),children=json_extract(j.value,'$.children'),
          plans=json_extract(j.value,'$.plans'),input_hash=json_extract(j.value,'$.input_hash'),input_chars=json_extract(j.value,'$.input_chars')
        FROM json_each(?) j WHERE project_id=? AND session_id=? AND generation=? AND prompt_id=json_extract(j.value,'$.id')`)
        .bind(JSON.stringify(settled), p, s, g));
    }
    if (this.paths.size > 0) {
      statements.push(db.prepare(`INSERT INTO session_paths (project_id,session_id,generation,path,tool_calls,last_at)
        SELECT ?,?,?,json_extract(j.value,'$.path'),json_extract(j.value,'$.n'),json_extract(j.value,'$.at') FROM json_each(?) j
          WHERE EXISTS (SELECT 1 FROM session_paths h WHERE h.project_id=? AND h.session_id=? AND h.generation=? AND h.path=json_extract(j.value,'$.path'))
            OR (SELECT COUNT(*) FROM session_paths h WHERE h.project_id=? AND h.session_id=? AND h.generation=?) < ${SESSION_PATHS_LIMIT}
        ON CONFLICT (project_id,session_id,generation,path) DO UPDATE SET tool_calls=tool_calls+excluded.tool_calls,last_at=MAX(last_at,excluded.last_at)`)
        .bind(p, s, g, JSON.stringify([...this.paths].map(([path, held]) => ({ path, n: held.n, at: held.at }))), p, s, g, p, s, g));
    }
    if (this.mycoCalls.size > 0) {
      statements.push(db.prepare(`INSERT INTO myco_tool_calls (project_id,session_id,generation,tool_call_id,myco_tool,myco_op,success,created_at,harness)
        SELECT ?,?,?,json_extract(value,'$.id'),json_extract(value,'$.tool'),json_extract(value,'$.op'),json_extract(value,'$.ok'),
          json_extract(value,'$.at'),json_extract(value,'$.harness') FROM json_each(?) WHERE true
        ON CONFLICT (project_id,session_id,generation,tool_call_id) DO UPDATE SET myco_op=excluded.myco_op,success=excluded.success`)
        .bind(p, s, g, JSON.stringify([...this.mycoCalls.values()].map((record) => ({
          id: record.id, tool: record.myco_tool, op: record.myco_op ?? null, ok: record.success, at: record.created_at, harness: record.harness,
        })))));
    }
    if (this.consumed.length > 0) {
      statements.push(db.prepare(`DELETE FROM publish_queue WHERE project_id=? AND session_id=? AND event_id IN (SELECT value FROM json_each(?))`)
        .bind(p, s, JSON.stringify(this.consumed)));
    }
    const sizes = Object.fromEntries(this.publications.map((pub) => [pub.transcript.transcript_id, pub.transcript.size]));
    const behind = this.publications.some((pub) => pub.state === 'active' && pub.offset < pub.transcript.size);
    const terminalDue = this.publications.filter((pub) => pub.state !== 'failed' && pub.unfinished === 1)
      .map((pub) => pub.transcript.last_received_at + TRANSCRIPT_IDLE_MS);
    const dueAt = behind || this.more ? 0 : terminalDue.length === 0 ? null : Math.min(...terminalDue);
    statements.push(db.prepare(`UPDATE session_documents SET prompts=prompts+?,user_prompts=user_prompts+?,replies=replies+?,tool_calls=tool_calls+?,
        failed_tools=failed_tools+?,plans=plans+?,first_prompt=?,open_turn_key=?,last_record_at=MAX(COALESCE(last_record_at,0),COALESCE(?,0)),
        next_chunk=?,updated_at=?,
        due_at=CASE WHEN EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id=? AND t.session_id=?
          AND t.size IS NOT json_extract(?, '$."' || t.transcript_id || '"')) THEN 0 ELSE ? END
      WHERE project_id=? AND session_id=?`)
      .bind(this.counts.prompts, this.counts.user_prompts, this.counts.replies, this.counts.tool_calls, this.counts.failed_tools, this.counts.plans,
        this.firstPrompt, this.openTurn, this.lastRecordAt, this.writer.nextChunk, this.now, p, s, JSON.stringify(sizes), dueAt, p, s));
    return statements;
  }
}
