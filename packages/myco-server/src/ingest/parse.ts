/**
 * Reading a transcript the Deployment holds, and deriving its rows.
 *
 * The member ships transcript bytes and the Deployment stores them opaquely.
 * This is where they become prompts, responses, tool calls and plans — the same
 * rows a hook event produces, through the same projections, so a row has one
 * shape whatever produced it.
 *
 * **The pass is bounded by outbound calls and wall time, not by bytes.** A
 * hosted runtime caps the calls one invocation may make, and store reads and
 * blob reads both count against that cap. Deriving each event through its own
 * batch would spend one call per event and exhaust the cap on a single turn, so
 * a pass collects up to `EVENTS_PER_BATCH` writes and lands them in ONE batch,
 * and stops once it has spent the platform's declared budget (`JobBudget`) or
 * its wall time. The tick that runs this also runs the other jobs, which share
 * the invocation's cap; a pass that leaves work says so, and the tick wakes
 * again soon rather than at its cadence.
 *
 * **A pass consumes only complete lines**, and the cursor advances to the byte
 * past the last one (`segments.ts`). Continuation is committed with that
 * integer, so a pass that dies cannot advance beyond its durable state.
 *
 * **The cursor never passes an event that did not land.** A derived event that
 * comes back unpersisted stops the transcript and stamps the failure. Advancing
 * regardless is the one defect that would lose rows silently and in bulk, which
 * is exactly what a transcript-first design cannot afford.
 */
import type { JobBudget, PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import type { JobOutcome } from '../core/jobs-run.js';
import { emit, type Classifier } from '../telemetry.js';
import { utf8, uuidv5 } from '../hash.js';
import { MAX_PAYLOAD_BYTES } from './envelope.js';
import { planEventWrite, type EventWrite, type IngestResult } from './events.js';
import { idFields, kindSpec } from './kinds.js';
import { parserFor } from './parsers/registry.js';
import { isBlock, type DerivedEvent, type ParsedLine, type ParserState } from './parsers/index.js';
import { resolvePresentedDates } from './projections.js';
import { LEGACY_REPLY_LINES_PER_READ, legacyReplies, preserveLegacyReplies } from './legacy-replies.js';
import { parserCheckpointStatements, readParserCheckpoint } from './parser-checkpoint.js';
import { segmentsToRead, splitCompleteLines } from './segments.js';
import { registeredObjectKeySql } from '../core/blob-objects.js';
import { MAX_BLOB_BYTES, SERVER_PROTOCOL, TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';

/** Derived events collapsed into one database call. */
export const TRANSCRIPT_PARSE_EVENTS_PER_BATCH = 50;
/**
 * The payload bytes one database call may carry: what the twenty events a call held before could carry at most. More
 * events share a call only while their payloads are small, so a call never carries more than it ever has.
 */
export const TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES = 20 * MAX_PAYLOAD_BYTES;

/**
 * A pass's derived events as the groups it writes, one database call each, in order: at most
 * `TRANSCRIPT_PARSE_EVENTS_PER_BATCH` events and `TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES` of payload per group, and
 * never an empty group.
 */
export function eventGroups(events: readonly DerivedEvent[]): DerivedEvent[][] {
  const groups: DerivedEvent[][] = [];
  let open: DerivedEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = utf8(JSON.stringify(event.payload)).byteLength;
    if (open.length > 0 && (open.length >= TRANSCRIPT_PARSE_EVENTS_PER_BATCH || bytes + size > TRANSCRIPT_PARSE_BATCH_PAYLOAD_BYTES)) {
      groups.push(open);
      open = [];
      bytes = 0;
    }
    open.push(event);
    bytes += size;
  }
  if (open.length > 0) groups.push(open);
  return groups;
}
/** Normal read floor; an unfinished first record may use the bounded segment lookahead. */
export const TRANSCRIPT_PARSE_BYTES_PER_READ = 524_288;
/** Segments read in one pass. Bytes alone do not bound the READS: a transcript shipped in many small segments sits inside the byte budget while costing one read each. */
export const TRANSCRIPT_PARSE_SEGMENTS_PER_READ = 8;
/**
 * Imported transcripts one selection takes, read side by side. Each store and blob call is a round trip whose time is
 * the trip rather than the query, so a pass over several transcripts at once spends the same wall time on more work.
 */
export const TRANSCRIPT_PARSE_IMPORTED_AT_ONCE = 4;
/**
 * The segment bytes passes read side by side may hold at once. A pass holds its segment's bytes, the lines parsed from
 * them and the events derived from those until its last write, several times the segment's size in all, in an object
 * whose memory an embedding run shares. At most one full 8 MiB segment, so a full segment is read alone while small
 * ones are read together.
 */
export const TRANSCRIPT_PARSE_CONCURRENT_BYTES = 8 * 1024 * 1024;
/** Maximum bytes retained while completing the first record across segments. */
export const TRANSCRIPT_PARSE_RECORD_BYTES = MAX_BLOB_BYTES;

/**
 * The parse's own version.
 *
 * A transcript records the version that read it, and a transcript stopped by a
 * failure is offered again once this moves. The transcript format is
 * version-unstable by its vendors' own documentation, so a break is expected to
 * be answered by a deploy — and a failure nothing can clear would mean one bad
 * line silences a transcript permanently, which no later fix could undo.
 */
export const PARSER_VERSION = 4;

/**
 * Unreadable lines ONE WINDOW tolerates before the transcript is stopped.
 *
 * Per window rather than per file, and deliberately: a file scattered with the
 * occasional bad line stays readable however long it runs, while a run of them
 * close together says the bytes are no longer this format and stops it. A
 * per-file count would let a long transcript accumulate its way to a halt for
 * damage it had already read past.
 *
 * A line that is not JSON is a defect, but one of them is not a reason to
 * abandon every row the rest of the file still holds — losing thousands of rows
 * to one corrupt line is the larger data loss.
 */
export const TRANSCRIPT_PARSE_MALFORMED_LIMIT = 8;

/** What a derived event says produced it. The one field that separates a parsed row from a hook-shipped one, and what the parity gate partitions on. */
export const TRANSCRIPT_PRODUCER = { adapter: TRANSCRIPT_PARSE_ADAPTER, version: String(SERVER_PROTOCOL) } as const;

/**
 * What a transcript records when everything past its cursor is one record
 * still being written. It is not a fault: the transcript leaves the queue, so
 * it neither holds back the transcripts behind it nor keeps the Deployment
 * awake, and the next segment to arrive puts it back (`PENDING_TRANSCRIPTS`).
 * `parse_awaited_size` holds the size that pass read, so the wait is keyed on
 * bytes rather than on a clock.
 */
export const AWAITING_BYTES = 'awaiting_bytes';

/**
 * Which transcripts still owe a pass: bytes unread, and either no failure, a
 * failure recorded against an older parser, or a wait (`AWAITING_BYTES`) on a
 * transcript that has grown past the size it waited at.
 *
 * `nextTarget` and `pendingTranscripts` share it, with the same tombstone
 * filter. Counting work the selection would not take keeps a Deployment awake
 * for nothing; counting less than it takes leaves a transcript a newer parser
 * has reopened unread until something else wakes the tick.
 */
export const PENDING_TRANSCRIPTS = `parsed_offset < size AND (parse_error IS NULL OR parser_version < ? OR (parse_error = '${AWAITING_BYTES}' AND size > COALESCE(parse_awaited_size, -1)))`;

/** The transcript a pass works on. */
interface ParseTarget {
  projectId: string;
  transcriptId: string;
  sessionId: string;
  machineId: string;
  tokenId: string;
  agent: string | null;
  size: number;
  parsedOffset: number;
  fidelity: string | null;
  /** The turn open where the cursor stands, recorded by the pass that stopped there. */
  openPromptId: string | null;
  parserContext?: Record<string, unknown> | null;
  /** Whether the latest segment arrived by import; lifecycle ownership is resolved from durable events. */
  imported: boolean;
  /** The line breaks between the first byte of the segment holding the cursor and the cursor, or null where not known. */
  segmentLines?: number | null;
  /** The segments past the cursor, read with the selection; absent where the pass reads them itself. */
  segments?: SegmentRow[];
}

/** A segment row as a pass reads it: where it sits in the transcript, its bytes' stored object, and the time its event carries. */
interface SegmentRow { base_offset: number; length: number; blob_key: string; object_key: string | null; created_at: number }

/** The columns of a segment a pass reads, over `transcript_segments s` joined to the event that sent it as `e`. */
const SEGMENT_COLUMNS = `s.base_offset, s.length, s.blob_key, COALESCE(e.created_at, s.created_at) AS created_at, ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key`;

function contextFromStored(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new Error('Stored transcript context is not JSON text');
  const context: unknown = JSON.parse(raw);
  if (!isBlock(context)) throw new Error('Stored transcript context is not an object');
  return context;
}

/**
 * Why a transcript's parse stopped. Each is a stable classifier a dashboard and an operator read; none is a caller's
 * text. `record_too_large` names one record longer than a pass can hold (`TRANSCRIPT_PARSE_RECORD_BYTES`, or more
 * than `TRANSCRIPT_PARSE_SEGMENTS_PER_READ` segments with no line end): the transcript stops there, visibly, rather
 * than reading on past a record it cannot read.
 */
/**
 * Why a transcript stopped. `event_refused` is an event the parser derived and
 * the catalogue refused, a parser defect a deploy answers; `parse` is bytes
 * that cannot be read as the agent's transcript.
 */
export type ParseFailure = Extract<Classifier, 'parse'> | 'event_refused' | 'blob_absent' | 'record_too_large';

/** Which half of the queue a selection draws from: transcripts a hook shipped, or ones an import sent. */
export type Lane = 'live' | 'imported';

/**
 * The order each half is read in. Live transcripts go oldest receipt first, so the session being worked in is read
 * as it grows. Imported ones go smallest remaining first: a backlog of many short sessions and a few long ones
 * finishes the short ones in minutes instead of waiting behind the longest.
 */
const LANE_ORDER: Record<Lane, { where: string; order: string }> = {
  live: { where: 'imported_at IS NULL', order: 'last_received_at, transcript_id' },
  imported: { where: 'imported_at IS NOT NULL', order: 'size - parsed_offset, transcript_id' },
};


/** A transcript whose session is deleted, for a statement over `transcripts`: its bytes are never read. */
const TOMBSTONED = `EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = transcripts.project_id AND t.session_id = transcripts.session_id)`;

/**
 * The selection of the next `limit` transcripts in `lane`, bound to the parser version, each with the segments a pass
 * reads past its cursor: one statement and one round trip, which a gate reads the plan of.
 */
export function laneSelectionSql(lane: Lane, limit = 1): string {
  const segments = `SELECT json_group_array(json_object('base_offset', base_offset, 'length', length, 'blob_key', blob_key, 'created_at', created_at, 'object_key', object_key))
      FROM (SELECT ${SEGMENT_COLUMNS}
              FROM transcript_segments s
              LEFT JOIN events e ON e.project_id = s.project_id AND e.event_id = s.event_id
             WHERE s.project_id = transcripts.project_id AND s.transcript_id = transcripts.transcript_id AND s.base_offset + s.length > transcripts.parsed_offset
             ORDER BY s.base_offset LIMIT ${TRANSCRIPT_PARSE_SEGMENTS_PER_READ})`;
  return `SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity, open_prompt_id, parser_context, imported_at, parse_segment_lines,
                 (${segments}) AS segments
            FROM transcripts
           WHERE ${PENDING_TRANSCRIPTS} AND ${LANE_ORDER[lane].where} AND NOT ${TOMBSTONED}
           ORDER BY ${LANE_ORDER[lane].order} LIMIT ${limit}`;
}

/** The next `limit` transcripts in `lane` with unread bytes and no failure holding them, in the lane's order. */
async function nextTargets(db: RelationalStore, lane: Lane, limit: number): Promise<ParseTarget[]> {
  const { results } = await db
    .prepare(laneSelectionSql(lane, limit))
    .bind(PARSER_VERSION)
    .all<Record<string, unknown>>();
  return results.map(targetOf);
}

/** A selected row as the pass it is handed to reads it. */
function targetOf(row: Record<string, unknown>): ParseTarget {
  const segments = typeof row.segments === 'string' ? (JSON.parse(row.segments) as SegmentRow[]).sort((a, b) => a.base_offset - b.base_offset) : undefined;
  return {
    projectId: row.project_id as string,
    transcriptId: row.transcript_id as string,
    sessionId: row.session_id as string,
    machineId: row.machine_id as string,
    tokenId: row.token_id as string,
    agent: (row.agent as string | null) ?? null,
    size: row.size as number,
    parsedOffset: (row.parsed_offset as number | null) ?? 0,
    fidelity: (row.fidelity as string | null) ?? null,
    openPromptId: (row.open_prompt_id as string | null) ?? null,
    parserContext: contextFromStored(row.parser_context),
    imported: row.imported_at !== null && row.imported_at !== undefined,
    segmentLines: (row.parse_segment_lines as number | null | undefined) ?? null,
    ...(segments === undefined ? {} : { segments }),
  };
}

/** The prompt that opens a turn; delayed results retain their own prompt without changing the active turn. */
function turnOf(event: DerivedEvent): string | null {
  if (event.kind !== 'prompt' || event.opensTurn === false) return null;
  const named = event.payload.promptId;
  return typeof named === 'string' ? named : null;
}

/** Persists pass state and the dates of retained imported rows in one batch. */
async function finalizePass(db: RelationalStore, target: ParseTarget, statement: PreparedStatement | PreparedStatement[]): Promise<void> {
  await db.batch([...(Array.isArray(statement) ? statement : [statement]), ...(target.imported ? [resolvePresentedDates(db, target.projectId, target.sessionId)] : [])]);
}

/** Stop this transcript where it stands and say why. Its rows to this point are kept; later passes skip it until the failure is cleared. */
async function stop(db: RelationalStore, target: ParseTarget, classifier: ParseFailure, now: number, refused?: { eventKind: string; refusal: Classifier }): Promise<void> {
  const statement = db
    .prepare(`UPDATE transcripts SET parse_error = ?, parse_failed_at = ?, parser_version = ? WHERE project_id = ? AND transcript_id = ?`)
    .bind(classifier, now, PARSER_VERSION, target.projectId, target.transcriptId);
  await finalizePass(db, target, statement);
  emit({ kind: 'transcript_parse_failed', projectId: target.projectId, transcriptId: target.transcriptId, failure: classifier, offset: target.parsedOffset, ...(refused ?? {}) });
}

/**
 * Take a transcript out of the queue until it grows past the size this pass
 * read. A segment that lands while the pass runs has already grown it past
 * that size, so the transcript stays queued.
 */
async function awaitBytes(db: RelationalStore, target: ParseTarget, now: number): Promise<void> {
  const statement = db
    .prepare(`UPDATE transcripts SET parse_error = ?, parse_awaited_size = ?, parse_failed_at = ?, parser_version = ? WHERE project_id = ? AND transcript_id = ?`)
    .bind(AWAITING_BYTES, target.size, now, PARSER_VERSION, target.projectId, target.transcriptId);
  await finalizePass(db, target, statement);
  emit({ kind: 'transcript_awaiting_bytes', projectId: target.projectId, transcriptId: target.transcriptId, offset: target.parsedOffset });
}

/**
 * A segment a pass read: when its bytes were sent, the bytes themselves, the byte of the transcript they begin at
 * (the segment's first, or the cursor where the pass read on from it), and the line breaks between the segment's
 * first byte and that one.
 */
interface HeldSegment {
  start: number;
  lineBase: number;
  createdAt: number;
  bytes: Uint8Array;
}

/** The line breaks in `bytes` before index `end`. */
function lineBreaks(bytes: Uint8Array, end: number): number {
  let n = 0;
  const before = bytes.subarray(0, end);
  for (let at = before.indexOf(0x0a); at >= 0; at = before.indexOf(0x0a, at + 1)) n += 1;
  return n;
}

/** The line breaks between the first byte of the held segment holding `offset` and `offset`; 0 where no held segment holds it, which is a segment's first byte or the end. */
function segmentLinesAt(offset: number, held: readonly HeldSegment[]): number {
  const segment = held.find((s) => offset >= s.start && offset < s.start + s.bytes.length);
  return segment === undefined ? 0 : segment.lineBase + lineBreaks(segment.bytes, offset - segment.start);
}

/**
 * Each line with the time its format leaves undated: the time its segment was
 * sent (the segment event's own date, which the segment row copies), plus its
 * position among the segment's lines in milliseconds.
 *
 * A line is written before the segment that carries it is sent, so the
 * segment's time is the nearest one the Deployment holds, on every channel.
 * The position keeps the lines of one segment in their order under the
 * `created_at, id` order every read of turns sorts by; the same line gets the
 * same position whichever pass reads it: it is counted from the segment's
 * first byte, not from where a pass began. Lines of two
 * segments keep their order while a segment holds fewer lines than the
 * milliseconds between it and the next. A line that carries its own time
 * keeps it (`lineTime`).
 */
function datedByPosition(lines: readonly ParsedLine[], held: readonly HeldSegment[]): ParsedLine[] {
  return lines.map((line) => {
    const segment = held.find((s) => line.offset >= s.start && line.offset < s.start + s.bytes.length);
    if (segment === undefined) return line;
    return { ...line, undatedAt: segment.createdAt + segment.lineBase + lineBreaks(segment.bytes, line.offset - segment.start) };
  });
}

/**
 * Move a cursor no held segment covers to the first byte that is still held,
 * or to the end when none is. The bytes between are gone and nothing can read
 * them; stopping would leave the transcript unable to take the segments that
 * arrive after it. A header those bytes held is recorded as absent, so the
 * pass after this one reads on without it.
 */
async function skipUnheld(
  db: RelationalStore, target: ParseTarget, parser: NonNullable<ReturnType<typeof parserFor>>, nextHeld: number | null,
  recoveringHeader: boolean, now: number, calls: number,
): Promise<PassReport> {
  if (recoveringHeader) {
    await db.prepare('UPDATE transcripts SET parser_context = ? WHERE project_id = ? AND transcript_id = ?')
      .bind(JSON.stringify(parser.headerContext?.([]) ?? {}), target.projectId, target.transcriptId).run();
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: null };
  }
  const to = Math.max(nextHeld ?? target.size, target.parsedOffset);
  // Where the cursor now stands is a segment's first byte or the end: no line of its segment is behind it.
  const statement = db
    .prepare(`UPDATE transcripts SET parse_segment_lines = CASE WHEN ? >= parsed_offset THEN 0 ELSE NULL END, parsed_offset = MAX(parsed_offset, ?), parsed_at = ?,
                 open_prompt_id = NULL, parser_context = NULL, parse_error = NULL, parse_failed_at = NULL, parse_awaited_size = NULL
               WHERE project_id = ? AND transcript_id = ?`)
    .bind(to, to, now, target.projectId, target.transcriptId);
  await finalizePass(db, target, statement);
  emit({ kind: 'transcript_bytes_unheld', projectId: target.projectId, transcriptId: target.transcriptId, from: target.parsedOffset, to });
  return { derived: 0, calls: calls + 1, nextOffset: to, failure: null };
}

/**
 * The unterminated tail of the held bytes, when it is a whole record: the
 * line it holds (null for one the formats skip, such as blank space or a
 * non-object), or null when it does not parse and so is still being written.
 */
function finalRecord(bytes: Uint8Array, offset: number): { line: ParsedLine | null } | null {
  const text = new TextDecoder('utf-8').decode(bytes).trim();
  if (text === '') return { line: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return { line: value !== null && typeof value === 'object' && !Array.isArray(value) ? { value: value as Record<string, unknown>, offset } : null };
}

/** The bytes of one segment from `from` on, by the stored object its registered blob names, or null when nothing registers or stores them. */
async function segmentBytes(env: Pick<ServerEnv, 'blobs'>, objectKey: string | null, from: number): Promise<Uint8Array | null> {
  if (objectKey === null) return null;
  const held = await env.blobs.get(objectKey, from > 0 ? { range: { offset: from } } : undefined);
  if (held === null) return null;
  return new Uint8Array(await new Response(held.body).arrayBuffer());
}

/**
 * What names a derived event: the row identity its payload carries.
 *
 * The catalogue already marks that field — the one id whose role is `key` — so
 * this reads the registry rather than a list kept in step by hand.
 *
 * The byte offset cannot serve. One assistant line routinely carries several
 * `tool_use` blocks, and one text block several plan envelopes, so every event
 * from that line shares its offset: keying on `(offset, kind)` gave two of them
 * one id, and the second is refused as an id conflict, does not land, and
 * stops the transcript permanently. Parallel tool calls are ordinary
 * behaviour, so that is the common case rather than a corner.
 */
function rowIdentity(event: DerivedEvent): string {
  const spec = kindSpec(event.kind);
  if (spec === null) return `@${event.offset}`;
  const ids = idFields(spec);
  // A `key` role names the row outright. `prompt` is the exception the
  // catalogue models differently: its id carries the `prompt` role, marking
  // what other kinds reference, and is still the row's own name — so a required
  // id field stands in where no `key` is declared.
  const field = (ids.find(([, role]) => role === 'key') ?? ids.find(([name]) => spec.fields[name]?.required === true))?.[0];
  const value = field === undefined ? undefined : event.payload[field];
  return typeof value === 'string' ? value : `@${event.offset}`;
}

/** The envelope a derived event travels in: a deterministic id over the row it names, so a repeated pass re-derives the same row and the raw insert absorbs it. */
async function envelopeFor(target: ParseTarget, event: DerivedEvent): Promise<Record<string, unknown>> {
  return {
    eventId: await uuidv5('transcript-event', target.transcriptId, event.kind, rowIdentity(event)),
    sessionId: target.sessionId,
    kind: event.kind,
    createdAt: event.createdAt,
    channel: 'cli',
    producer: TRANSCRIPT_PRODUCER,
    payload: event.payload,
  };
}

/**
 * Whether the row this event names is now in the store.
 *
 * A duplicate counts: the same row with the same content is already there.
 *
 * An id conflict also counts, and it is NOT the same thing. The id covers the
 * row's identity, not its content, so a conflict means this row is stored with
 * DIFFERENT content — and the stored version wins. This pass's version is
 * dropped, and `transcript_row_conflict` is emitted so the loss is visible
 * rather than inferred. It still counts as landed: the row exists and the
 * cursor must move, and stopping the transcript over a row already recorded
 * would cost every row after it, which is the larger loss.
 *
 * A backfill inherits that rule and should not want it. Re-importing a
 * transcript over rows an older parser or a hook already wrote keeps the older
 * content silently, which is the wrong default for #1148 — it needs an explicit
 * decision about which version wins, not this one.
 *
 * Every other refusal is a genuine failure and stops the transcript where it
 * stands, which is what keeps the cursor from passing a row that never landed.
 */
function landed(result: IngestResult, target: ParseTarget, event: DerivedEvent): boolean {
  if (result.persisted === true) return true;
  if (result.code !== 'event_id_conflict') return false;
  emit({ kind: 'transcript_row_conflict', projectId: target.projectId, transcriptId: target.transcriptId, eventKind: event.kind });
  return true;
}


/** What one pass may spend: store and blob calls, and the instant (on `clock`) past which it starts no more work. */
export interface PassLimits {
  calls: number;
  deadline: number;
  clock: () => number;
}

/** Whether a pass has spent what it may. */
const spentAll = (limits: PassLimits, calls: number): boolean => calls >= limits.calls || limits.clock() >= limits.deadline;

export interface PassReport {
  /** Events that landed this pass. */
  derived: number;
  /** Store and blob calls this pass spent, excluding the caller's own selection of it. */
  calls: number;
  /** The byte the cursor now stands at, or null when the pass did nothing. */
  nextOffset: number | null;
  /** Why the transcript stopped, or that it waits on bytes still to arrive; null when it moved or has nothing more to give yet. */
  failure: ParseFailure | typeof AWAITING_BYTES | null;
}

/**
 * One transcript, one pass.
 *
 * Reads the segments covering the cursor up to the read bound, derives what the
 * complete lines in them hold, lands the events in batches, and advances the
 * cursor to the byte past the last complete line — but only over events that
 * landed.
 */
export async function parseOnce(env: Pick<ServerEnv, 'db' | 'blobs'>, target: ParseTarget, now: number, limits: PassLimits): Promise<PassReport> {
  const parser = parserFor(target.agent);
  if (parser === null) {
    // Nothing here reads this agent's format. The bytes are kept and the cursor
    // is moved to the end, so the transcript stops being offered to every pass.
    await env.db.prepare(`UPDATE transcripts SET parsed_offset = size, parse_segment_lines = 0, parsed_at = ?, parser_version = ? WHERE project_id = ? AND transcript_id = ?`)
      .bind(now, PARSER_VERSION, target.projectId, target.transcriptId).run();
    return { derived: 0, calls: 1, nextOffset: target.size, failure: null };
  }

  // `calls` counts what THIS pass spends; the caller adds its own selection.
  let calls = 0;
  const needsHeader = parser.headerContext !== undefined && target.parserContext == null;
  const recoveringHeader = needsHeader && target.parsedOffset > 0;
  const readOffset = recoveringHeader ? 0 : target.parsedOffset;
  // The selection read the segments past the cursor with the transcript; a pass reading from elsewhere reads its own.
  let segments: SegmentRow[];
  if (target.segments !== undefined && readOffset === target.parsedOffset) segments = target.segments;
  else {
    segments = (await env.db
      .prepare(`SELECT ${SEGMENT_COLUMNS}
                  FROM transcript_segments s
                  LEFT JOIN events e ON e.project_id = s.project_id AND e.event_id = s.event_id
                 WHERE s.project_id = ? AND s.transcript_id = ? AND s.base_offset + s.length > ?
                 ORDER BY s.base_offset`)
      .bind(target.projectId, target.transcriptId, readOffset)
      .all<SegmentRow>()).results;
    calls += 1;
  }

  const taken = segmentsToRead(
    segments.map((s) => ({ baseOffset: s.base_offset, length: s.length, blobKey: s.blob_key, objectKey: s.object_key, createdAt: s.created_at })),
    readOffset, Number.POSITIVE_INFINITY, TRANSCRIPT_PARSE_SEGMENTS_PER_READ,
  );
  if (taken.length === 0) return skipUnheld(env.db, target, parser, segments[0]?.base_offset ?? null, recoveringHeader, now, calls);

  let chunks: Uint8Array[] = [];
  let unreadBytes = 0;
  let hasCompleteLine = false;
  let held: HeldSegment[] = [];
  for (const [n, segment] of taken.entries()) {
    // The segment the cursor stands inside is read from the cursor where the lines behind it in that segment are
    // counted, and from its first byte where they are not, counting them as it goes.
    const from = n === 0 && readOffset > segment.baseOffset && target.segmentLines != null ? readOffset : segment.baseOffset;
    const bytes = await segmentBytes(env, segment.objectKey, from - segment.baseOffset);
    calls += 1;
    if (bytes === null) {
      await stop(env.db, target, 'blob_absent', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'blob_absent' };
    }
    let unread = bytes.subarray(Math.max(0, readOffset - from));
    if (unreadBytes >= TRANSCRIPT_PARSE_BYTES_PER_READ && !hasCompleteLine) {
      const newline = unread.indexOf(0x0a);
      if (newline >= 0) unread = unread.subarray(0, newline + 1);
    }
    unreadBytes += unread.length;
    if (unreadBytes > TRANSCRIPT_PARSE_RECORD_BYTES) {
      await stop(env.db, target, 'record_too_large', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'record_too_large' };
    }
    chunks.push(unread);
    held.push({ start: from, lineBase: from === segment.baseOffset ? 0 : target.segmentLines!, createdAt: segment.createdAt, bytes });
    hasCompleteLine ||= unread.includes(0x0a);
    if (unreadBytes >= TRANSCRIPT_PARSE_BYTES_PER_READ && hasCompleteLine) break;
  }

  let joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }
  const readChunks = chunks.length;
  chunks = [];

  let split: ReturnType<typeof splitCompleteLines> | null = splitCompleteLines(joined, readOffset);

  if (split.malformed > TRANSCRIPT_PARSE_MALFORMED_LIMIT) {
    await stop(env.db, target, 'parse', now);
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'parse' };
  }
  if (split.malformed > 0) emit({ kind: 'transcript_lines_unreadable', projectId: target.projectId, transcriptId: target.transcriptId, lines: split.malformed });

  // The last record of a file its writer never ended with a newline is still a
  // record: a tail reaching the end of the held bytes that parses whole is
  // read with the rest. A tail that does not parse is a record still being
  // written, and waits for the bytes that finish it.
  const heldEnd = readOffset + joined.length;
  const tail = heldEnd === target.size ? finalRecord(joined.subarray(split.nextOffset - readOffset), split.nextOffset) : null;
  let windowLines: ParsedLine[] | null = tail?.line === undefined || tail.line === null ? split.lines : [...split.lines, tail.line];
  let windowEnd = tail === null ? split.nextOffset : heldEnd;
  // The window is lines from here on: its bytes are not read again.
  joined = new Uint8Array(0);
  split = null;

  if (windowEnd === readOffset) {
    if (readChunks === TRANSCRIPT_PARSE_SEGMENTS_PER_READ && heldEnd < target.size) {
      await stop(env.db, target, 'record_too_large', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'record_too_large' };
    }
    // Everything past the cursor is one record still being written.
    await awaitBytes(env.db, target, now);
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: AWAITING_BYTES };
  }

  // The turn open where this window begins, as the pass that stopped here
  // recorded it. With it, an event derived after a break is identical to the
  // same event derived in one uninterrupted read, so a pass may stop anywhere
  // rather than only where a turn begins.
  const stored = target.parserContext;
  const continued = stored?.mycoParserState;
  if (continued !== undefined && !isBlock(continued)) throw new Error('Stored parser continuation is not an object');
  const transcriptMeta = stored?.mycoParserMeta !== undefined
    ? (isBlock(stored.mycoParserMeta) ? stored.mycoParserMeta : undefined)
    : stored === null || stored === undefined ? parser.headerContext?.(windowLines) : continued === undefined ? stored : undefined;
  if (recoveringHeader) {
    await env.db.prepare('UPDATE transcripts SET parser_context = ? WHERE project_id = ? AND transcript_id = ?')
      .bind(JSON.stringify(transcriptMeta), target.projectId, target.transcriptId).run();
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: null };
  }
  let lines: ParsedLine[] | null = datedByPosition(windowLines, held);
  windowLines = null;
  const chunkedState = continued?.chunked === true;
  const initialState: ParserState = chunkedState ? await readParserCheckpoint(env.db, target, continued?.digest) : structuredClone(continued ?? {});
  if (chunkedState) calls += 1;
  if (typeof stored?.mycoLegacyResponseUntil === 'number') initialState.legacyReplies = { until: stored.mycoLegacyResponseUntil };
  if (initialState.legacyReplies !== undefined && lines.length > LEGACY_REPLY_LINES_PER_READ) {
    windowEnd = lines[LEGACY_REPLY_LINES_PER_READ].offset;
    lines = lines.slice(0, LEGACY_REPLY_LINES_PER_READ);
  }
  const state: ParserState = structuredClone(initialState);
  const input = { lines, sessionId: target.sessionId, now, openPromptId: target.openPromptId ?? undefined, transcriptMeta, state };
  const parsedEvents = await parser.parse(input);
  const heldReplies = await legacyReplies(env.db, target.projectId, target.transcriptId, parsedEvents, initialState, () => { calls += 1; });
  const events = preserveLegacyReplies(parsedEvents, state, heldReplies);
  const stateAt = async (to: number): Promise<ParserState> => {
    const checkpoint = to === windowEnd ? state : structuredClone(initialState);
    if (to !== windowEnd) {
      const prefix = await parser.parse({ ...input, lines: input.lines.filter((line) => line.offset < to), state: checkpoint });
      preserveLegacyReplies(prefix, checkpoint, heldReplies);
    }
    return checkpoint;
  };
  lines = null;
  const ctx = { projectId: target.projectId, machineId: target.machineId, tokenId: target.tokenId, bodyBytes: 0, now, writeOrigin: 'server' as const };

  let derived = 0;
  let cursor = windowEnd;
  // The turn open at the cursor, carried in and moved by every event landed.
  // A pass ends for either of two reasons — the call budget, or the window's
  // own bound — and BOTH can fall mid-turn: the member slices at 8 MiB and a
  // pass takes the first segment whole, so an ordinary boundary lands inside a
  // turn under either bound. Tracking it here rather than at the break is what
  // makes the two ends behave alike.
  let lastTurn: string | null = target.openPromptId;
  /**
   * The cursor's advance to `to`, with the turn open there. With `landedIds`, it applies only once every one of those
   * events is in the store, so it can ride the batch that writes them: a pass whose last group did not land whole
   * leaves the cursor where it stood.
   */
  const advanceTo = async (to: number, openPrompt: string | null, landedIds?: readonly string[]): Promise<PreparedStatement[]> => {
    const guard = landedIds === undefined ? '' : ` AND (SELECT COUNT(*) FROM events WHERE project_id = ? AND event_id IN (${landedIds.map(() => '?').join(', ')})) = ?`;
    const checkpoint = await stateAt(to);
    return parserCheckpointStatements(env.db, target, to, checkpoint, transcriptMeta, chunkedState, (context) => env.db
      .prepare(`UPDATE transcripts SET parse_segment_lines = CASE WHEN ? >= parsed_offset THEN ? ELSE NULL END, parsed_offset = MAX(parsed_offset, ?), parsed_at = ?, parser_version = ?,
                   fidelity = COALESCE(fidelity, ?), open_prompt_id = CASE WHEN ? >= parsed_offset THEN ? ELSE open_prompt_id END, parser_context = CASE WHEN ? >= parsed_offset THEN ? ELSE parser_context END,
                   parse_error = NULL, parse_failed_at = NULL, parse_awaited_size = NULL
                 WHERE project_id = ? AND transcript_id = ?${guard}`)
      .bind(to, linesBehind(to), to, now, PARSER_VERSION, parser.fidelity, to, openPrompt, to, context,
        target.projectId, target.transcriptId, ...(landedIds === undefined ? [] : [target.projectId, ...landedIds, landedIds.length])));
  };
  // Whether the cursor's advance rode the last group's batch and applied there.
  let advanced = false;
  const groups = eventGroups(events);
  // The line counts every cursor this pass can end at needs, read before the writes so the segment bytes they are
  // counted in are let go first. Parsed records remain available for a cursor's continuation checkpoint.
  const linesAt = new Map<number, number>([windowEnd, ...groups.map((group) => group[0].offset)].map((offset) => [offset, segmentLinesAt(offset, held)]));
  held = [];
  const linesBehind = (offset: number): number => {
    const counted = linesAt.get(offset);
    if (counted === undefined) throw new Error(`no line count read for cursor ${offset}`);
    return counted;
  };
  for (const [g, group] of groups.entries()) {
    // The first group always runs, whatever the reads already cost, and the
    // budget ends a pass anywhere the cursor can actually move. A resumed pass
    // is handed the turn open at its start, so an event derived after a break
    // is identical to the same event derived without one; only the cursor
    // needs to advance, or the transcript would be re-read forever.
    if (g > 0 && spentAll(limits, calls) && group[0].offset > target.parsedOffset) {
      cursor = group[0].offset;
      break;
    }
    const writes: EventWrite[] = [];
    const eventIds = new Set<string>();
    for (const event of group) {
      const envelope = await envelopeFor(target, event);
      eventIds.add(envelope.eventId as string);
      const planned = await planEventWrite(env.db, ctx, envelope);
      if (!planned.ok) {
        // The catalogue refused an event this parser derived: telemetry names its kind and the refusal's classifier.
        await stop(env.db, target, 'event_refused', now, { eventKind: event.kind, refusal: planned.classifier });
        return { derived, calls: calls + 1, nextOffset: null, failure: 'event_refused' };
      }
      writes.push(planned.write);
    }
    // The last group carries the cursor's advance past the window, guarded on every event of the group being stored.
    const last = g === groups.length - 1 && cursor > target.parsedOffset;
    const envelopes = last ? [...eventIds] : [];
    const turnAfter = group.reduce<string | null>((turn, event) => turnOf(event) ?? turn, lastTurn);
    const advancement = last ? await advanceTo(cursor, turnAfter, envelopes) : [];
    const tail = last ? [...advancement, ...(target.imported ? [resolvePresentedDates(env.db, target.projectId, target.sessionId)] : [])] : [];
    const results = await env.db.batch([...writes.flatMap((w) => w.statements), ...tail]);
    calls += 1;
    if (last) advanced = (results[writes.reduce((n, w) => n + w.statements.length, 0) ] as { meta: { changes: number } }).meta.changes > 0;

    let offset = 0;
    for (const [n, write] of writes.entries()) {
      const slice = results.slice(offset, offset + write.statements.length);
      offset += write.statements.length;
      if (landed(write.interpret(slice), target, group[n])) {
        derived += 1;
        lastTurn = turnOf(group[n]) ?? lastTurn;
        continue;
      }
      // The cursor stops at the byte of the event that did not land, never past it.
      await stop(env.db, target, 'parse', now);
      return { derived, calls: calls + 1, nextOffset: group[n].offset, failure: 'parse' };
    }
  }

  // Every path above either advances the cursor or returns. A cursor that did
  // not move would leave the transcript pending and every wake re-deriving the
  // same events, so it stops the transcript rather than spinning on it.
  if (cursor <= target.parsedOffset) {
    await stop(env.db, target, 'parse', now);
    return { derived, calls: calls + 1, nextOffset: null, failure: 'parse' };
  }

  // Uploaded bytes may end mid-turn; later segments continue the same prompt. The lines of its segment behind the new
  // cursor, and the turn open there, go with it, so the next pass reads on from the cursor alone. A cursor another pass
  // moved further keeps its own turn and no count: the pass after reads that segment from its first byte. An advance
  // the last batch carried is already in place; one it could not prove (a row held elsewhere as a duplicate) is made here.
  if (!advanced) {
    await finalizePass(env.db, target, await advanceTo(cursor, lastTurn));
    calls += 1;
  }

  emit({ kind: 'transcript_parsed', projectId: target.projectId, transcriptId: target.transcriptId, derived, offset: cursor });
  return { derived, calls, nextOffset: cursor, failure: null };
}

/** The first byte of a transcript still held in a segment, for a statement over `transcripts`. */
const FIRST_HELD_BYTE = `SELECT MIN(s.base_offset) FROM transcript_segments s WHERE s.project_id = transcripts.project_id AND s.transcript_id = transcripts.transcript_id`;

/** Which stored transcripts to read again: every one an agent's parser reads, or one session's. */
export type RereadSelector = { agent: string } | { projectId: string; sessionId: string };

/**
 * Offer stored transcripts to the parse again from the first byte still held.
 *
 * A parser fix reaches only bytes read after it unless the sessions it already
 * read are read again; the raw bytes are kept for exactly this, until retention
 * prunes the segments already read. The cursor moves back to the first segment
 * retention left, never before it: bytes read from a later segment as if they
 * began earlier would name every row at the wrong offset, and each would land a
 * second time. A transcript that holds no segment is left where it stands. The
 * open turn and any recorded failure or wait are cleared, header context is
 * preserved, and the tick's own parse job
 * does the rest under its ordinary call budget.
 *
 * Reading again is idempotent. Every derived event is named by its transcript
 * and the row it produces (`envelopeFor`), so a row an earlier pass landed is
 * absorbed as a duplicate, and one whose content differs keeps what is stored
 * and emits `transcript_row_conflict` (`landed`). What reading again adds is
 * the rows an earlier parser missed. A tombstoned session stays unread: the
 * selection skips it.
 */
export async function rereadTranscripts(db: RelationalStore, selector: RereadSelector): Promise<number> {
  const where = 'agent' in selector
    ? { sql: 'agent = ?', params: [selector.agent] }
    : { sql: 'project_id = ? AND session_id = ?', params: [selector.projectId, selector.sessionId] };
  const result = await db
    .prepare(`UPDATE transcripts SET parsed_offset = (${FIRST_HELD_BYTE}), parse_segment_lines = 0, open_prompt_id = NULL, parser_context = json_object('mycoLegacyResponseUntil', parsed_offset, 'mycoParserMeta', CASE WHEN json_type(parser_context, '$.mycoParserMeta') IS NOT NULL THEN json_extract(parser_context, '$.mycoParserMeta') ELSE json(parser_context) END), parse_error = NULL, parse_failed_at = NULL, parse_awaited_size = NULL
               WHERE ${where.sql} AND (${FIRST_HELD_BYTE}) IS NOT NULL`)
    .bind(...where.params)
    .run();
  const reread = result.meta.changes;
  emit({ kind: 'transcripts_reread', ...('agent' in selector ? { agent: selector.agent } : { projectId: selector.projectId }), transcripts: reread });
  return reread;
}

/** The transcripts that still owe a pass, and the bytes they have left to read; the half an import sent, apart. */
export interface TranscriptBacklog {
  transcripts: number;
  bytes: number;
  imported: { transcripts: number; bytes: number };
}

/**
 * What the queue holds, in one read over the pending rows, with the selection's own tombstone filter: what keeps a
 * Deployment awake while a backlog stands, what the tick reports, and what the dashboard shows. The live half holds
 * the Deployment at `active`; an import backlog holds it only at `idle`, finishing as the Deployment is used.
 */
export async function pendingTranscripts(db: RelationalStore): Promise<TranscriptBacklog> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size - parsed_offset), 0) AS bytes,
                     COALESCE(SUM(CASE WHEN imported_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS imported_n,
                     COALESCE(SUM(CASE WHEN imported_at IS NOT NULL THEN size - parsed_offset ELSE 0 END), 0) AS imported_bytes
                FROM transcripts WHERE ${PENDING_TRANSCRIPTS} AND NOT ${TOMBSTONED}`)
    .bind(PARSER_VERSION)
    .first<{ n: number; bytes: number; imported_n: number; imported_bytes: number }>();
  return {
    transcripts: Number(row?.n ?? 0),
    bytes: Number(row?.bytes ?? 0),
    imported: { transcripts: Number(row?.imported_n ?? 0), bytes: Number(row?.imported_bytes ?? 0) },
  };
}

/** Transcripts of one Project the current parser stopped on a fault, and when the latest of them stopped. */
export interface StoppedTranscripts {
  projectId: string;
  transcripts: number;
  latestAt: number | null;
  /** How many stopped for each classifier (`ParseFailure`). */
  reasons: Record<string, number>;
}

/**
 * Transcripts the current parser stopped on a fault and will not read on from, per Project that accepts capture: bytes remain past the
 * cursor, and the failure recorded is not a wait for bytes still to arrive. A failure an older parser recorded is not
 * counted: the parse offers that transcript again (`PENDING_TRANSCRIPTS`). Read over the backlog index, whose
 * predicate every stopped transcript satisfies.
 */
export async function stoppedTranscripts(db: RelationalStore): Promise<StoppedTranscripts[]> {
  // Counted here rather than grouped in SQL: a GROUP BY leads the planner to walk every transcript in Project order,
  // where the rows wanted all sit in the backlog index.
  const { results } = await db
    .prepare(`SELECT project_id, parse_error, parse_failed_at FROM transcripts
                WHERE parsed_offset < size AND parse_error IS NOT NULL AND parse_error <> '${AWAITING_BYTES}' AND parser_version >= ? AND NOT ${TOMBSTONED}
                  AND EXISTS (SELECT 1 FROM projects p WHERE p.project_id = transcripts.project_id AND p.archived_at IS NULL)`)
    .bind(PARSER_VERSION)
    .all<{ project_id: string; parse_error: string; parse_failed_at: number | null }>();
  const byProject = new Map<string, StoppedTranscripts>();
  for (const row of results) {
    const held = byProject.get(row.project_id) ?? { projectId: row.project_id, transcripts: 0, latestAt: null, reasons: {} };
    held.transcripts += 1;
    held.reasons[row.parse_error] = (held.reasons[row.parse_error] ?? 0) + 1;
    if (row.parse_failed_at !== null && (held.latestAt === null || row.parse_failed_at > held.latestAt)) held.latestAt = row.parse_failed_at;
    byProject.set(row.project_id, held);
  }
  return [...byProject.values()].sort((a, b) => (b.latestAt ?? 0) - (a.latestAt ?? 0) || a.projectId.localeCompare(b.projectId));
}

/** What a run of the job may override: the budget, which is the platform's own unless named, and the clock its wall time runs on. */
export interface ParseJobOptions {
  budget?: JobBudget;
  clock?: () => number;
  /** Told as each pass starts, with the segment bytes it is counted at, and as it ends: a test's view of what is held at once. */
  passes?: { started(transcriptId: string, bytes: number): void; ended(transcriptId: string): void };
}

/**
 * The segment bytes a pass over `target` reads: its segments from the cursor until the read floor is met, as
 * `parseOnce` takes them. A target whose segments the selection did not carry counts as a whole budget, so it is read
 * alone.
 */
export function passBytes(target: { segments?: ReadonlyArray<{ base_offset: number; length: number }>; parsedOffset: number }): number {
  if (target.segments === undefined) return TRANSCRIPT_PARSE_CONCURRENT_BYTES;
  const taken = segmentsToRead(target.segments.map((s) => ({ baseOffset: s.base_offset, length: s.length })),
    target.parsedOffset, TRANSCRIPT_PARSE_BYTES_PER_READ, TRANSCRIPT_PARSE_SEGMENTS_PER_READ);
  return taken.reduce((n, s) => n + s.length, 0);
}

/**
 * Runs `work` over `items` side by side while the bytes of those running stay within `budget`, in order; an item
 * over the budget alone runs by itself. Answers each item's result in the items' order.
 */
export async function withinBytes<T, R>(items: readonly T[], bytesOf: (item: T) => number, budget: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const running = new Set<Promise<void>>();
  let held = 0;
  for (const [n, item] of items.entries()) {
    const bytes = bytesOf(item);
    while (running.size > 0 && held + bytes > budget) await Promise.race(running);
    held += bytes;
    const pass: Promise<void> = work(item).then((result) => { results[n] = result; }).finally(() => {
      held -= bytes;
      running.delete(pass);
    });
    running.add(pass);
  }
  await Promise.all(running);
  return results;
}

/**
 * The job: passes over the transcripts that need one until the platform's budget or its wall time is spent.
 *
 * Live transcripts are read first, and while imported ones wait, live reading takes at most half the budget: the
 * session being worked in still reads within seconds, and an import backlog moves every pass however busy live
 * capture is. A half with nothing left hands its share to the other. The answer says whether work remains, which the
 * tick answers with a wake soon after this one.
 */
export async function parseTranscripts(env: ServerEnv, now: number, options: ParseJobOptions = {}): Promise<JobOutcome> {
  const budget = options.budget ?? env.platform.jobBudget;
  const clock = options.clock ?? Date.now;
  const deadline = clock() + budget.wallMs;
  const liveShare = Math.max(1, Math.floor(budget.calls / 2));
  const done: Record<Lane, boolean> = { live: false, imported: false };
  let spent = 0;
  let liveSpent = 0;
  let derived = 0;
  while (spent < budget.calls && clock() < deadline) {
    const lane: Lane | null = !done.live && (done.imported || liveSpent < liveShare) ? 'live' : !done.imported ? 'imported' : null;
    if (lane === null) break;
    // Imported transcripts are read several at a time: each call waits on a round trip, not on the store.
    const targets = await nextTargets(env.db, lane, lane === 'imported' ? TRANSCRIPT_PARSE_IMPORTED_AT_ONCE : 1);
    spent += 1;
    if (lane === 'live') liveSpent += 1;
    if (targets.length === 0) {
      done[lane] = true;
      continue;
    }
    // A live pass takes what is left of the live share while imports wait, and the rest of the budget when none do;
    // passes read side by side share what their half may spend.
    const allowance = lane === 'live' && !done.imported ? Math.max(1, liveShare - liveSpent) : budget.calls - spent;
    const each = Math.max(1, Math.floor(Math.min(allowance, budget.calls - spent) / targets.length));
    // Side by side only while their segment bytes fit the budget, so full segments are read one at a time.
    const reports = await withinBytes(targets, passBytes, TRANSCRIPT_PARSE_CONCURRENT_BYTES, async (target) => {
      options.passes?.started(target.transcriptId, passBytes(target));
      try { return await parseOnce(env, target, now, { calls: each, deadline, clock }); } finally { options.passes?.ended(target.transcriptId); }
    });
    for (const report of reports) {
      spent += report.calls;
      if (lane === 'live') liveSpent += report.calls;
      derived += report.derived;
    }
    // Passes that moved nothing and failed nothing have no more to give this run; their half is finished for this run
    // rather than read again.
    if (reports.every((report) => report.nextOffset === null && report.failure === null)) done[lane] = true;
  }
  const more = !(done.live && done.imported) && (await pendingTranscripts(env.db)).transcripts > 0;
  return { changed: derived, more };
}
