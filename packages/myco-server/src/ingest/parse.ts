import type { RelationalStore, ServerEnv } from '../core/adapters.js';

import { emit, type Classifier } from '../telemetry.js';

import { parserFor } from './parsers/registry.js';

import { declaredScheme } from './prompt-scheme.js';

import { isRecordIdScheme, RecordIdentityError } from '@goondocks/myco-shared/record-identity';

import { type PromptIdScheme } from '@goondocks/myco-shared/prompt-identity';

import { isBlock, withoutPrompts, type DerivedEvent, type ParsedLine, type ParserState, type ParserInput, type PromptOwners } from './parsers/index.js';

import type { TranscriptRole } from '@goondocks/myco-shared/member-protocol';

import { segmentsToRead, splitCompleteLines } from './segments.js';

import { registeredObjectKeySql } from '../core/blob-objects.js';

import { remainingInvocationBudget } from '../core/content-budget.js';

import { MAX_BLOB_BYTES, SESSION_END_SETTLE_MS } from '../constants.js';

const PARSER_CHECKPOINT_HEADROOM = 64;

const PARSER_CLOSE_HEADROOM = 12;

/** Normal read floor; an unfinished first record may use the bounded segment lookahead. */
export const TRANSCRIPT_PARSE_BYTES_PER_READ = 524288;

export const VIEW_PARSE_BYTES_PER_READ = 65536;

/** Segments read in one pass. Bytes alone do not bound the READS: a transcript shipped in many small segments sits inside the byte budget while costing one read each. */
export const TRANSCRIPT_PARSE_SEGMENTS_PER_READ = 8;

/** Maximum bytes retained while completing the first record across segments. */
export const TRANSCRIPT_PARSE_RECORD_BYTES = MAX_BLOB_BYTES;

/** An unanswered live turn closes after ten minutes without new transcript bytes. */
export const TRANSCRIPT_IDLE_MS = 600000;

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
 * A checkpoint that carries a prompt forward (a turn open at its cursor, or calls or a reply unfinished) written under
 * another generation of its transcript's pinned scheme (`SCHEME_GENERATION_SQL`). Resumed, it would go on naming that
 * prompt as the parser that wrote it did, so a pass reads it again from its start instead (`repairCursors`). Where the bytes before its cursor are gone, it
 * resumes with no turn open and is marked `PROMPTS_DROPPED`: the next pass drops every prompt its continuation carries
 * (`withoutPrompts`), and the checkpoint that pass writes holds no mark.
 */
const PROMPTS_DROPPED = 'mycoParserPromptsDropped';

/** A stored context without one of its keys. */
const withoutKey = (context: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(context).filter(([name]) => name !== key));

export interface ParsePersistence {
    sourceTimes(offsets: readonly number[]): Promise<ReadonlyMap<number, number>>;
    checkpoint(digest: unknown): Promise<ParserState>;
    owners(keys: ReadonlyMap<string, string>): Promise<PromptOwners | undefined>;
    claim(claims: readonly KeyClaim[]): Promise<void>;
    stop(failure: ParseFailure, now: number, diagnostic?: ParseDiagnostic): Promise<void>;
    awaitBytes(now: number): Promise<void>;
    header(metadata: Record<string, unknown>): Promise<void>;
    publish(window: {
        events: DerivedEvent[];
        state: ParserState;
        metadata: Record<string, unknown> | undefined;
        to: number;
        lines: number;
        segmentLines: number;
        openPromptId: string | null;
        now: number;
        fidelity: string;
    }): Promise<number | null>;
}

/** The transcript a pass works on. */
export interface ParseTarget {
    persistence: ParsePersistence;
    projectId: string;
    transcriptId: string;
    sessionId: string;
    machineId: string;
    tokenId: string;
    agent: string | null;
    size: number;
    parsedOffset: number;
    fidelity: string | null;
    /** The transcript's pinned prompt identity scheme; null for one that names no agent this Deployment declares, or one its group could not be admitted to. */
    scheme: PromptIdScheme | null;
    recordScheme: string;
    /** How the transcript is registered; absent where the selection did not read it. */
    role?: TranscriptRole;
    /** The turn open where the cursor stands, recorded by the pass that stopped there. */
    openPromptId: string | null;
    /** The checkpoint carries a prompt forward under another prompt generation than its parser's (`PROMPT_IDENTITY_STALE`). */
    promptIdentityStale: boolean;
    parserContext?: Record<string, unknown> | null;
    parserContextJson?: string | null;
    lastReceivedAt?: number;
    sessionEndedAt?: number | null;
    turnEnded?: boolean;
    /** Whether the latest segment arrived by import; lifecycle ownership is resolved from durable events. */
    imported: boolean;
    /** The line breaks between the first byte of the segment holding the cursor and the cursor, or null where not known. */
    segmentLines?: number | null;
    /** The segments past the cursor, read with the selection; absent where the pass reads them itself. */
    segments?: SegmentRow[];
}

/** A segment row as a pass reads it: where it sits in the transcript, its bytes' stored object, and the time its event carries. */
export interface SegmentRow {
    base_offset: number;
    length: number;
    blob_key: string;
    object_key: string | null;
    created_at: number;
}

/** Both hot and archived segments provide the parser's exact registered object and original creation time. */
export const segmentSource = (project: string, transcript: string, after: string): string => {
    const [hotAfter, coldAfter] = after === '?' ? ['?3', '?6'] : [after, after];
    const [hotProject, coldProject] = project === '?' ? ['?1', '?4'] : [project, project];
    const [hotTranscript, coldTranscript] = transcript === '?' ? ['?2', '?5'] : [transcript, transcript];
    return `
  SELECT s.base_offset,s.length,s.blob_key,COALESCE(e.created_at,s.created_at) AS created_at,
    ${registeredObjectKeySql('s.project_id', 's.blob_key')} AS object_key
    FROM transcript_segments s LEFT JOIN events e ON e.project_id=s.project_id AND e.event_id=s.event_id
    WHERE s.project_id=${project} AND s.transcript_id=${transcript}
      AND s.base_offset>=COALESCE((SELECT MAX(k.base_offset) FROM transcript_segments k
        WHERE k.project_id=${hotProject} AND k.transcript_id=${hotTranscript} AND k.base_offset<=${hotAfter}),${hotAfter})
      AND s.base_offset+s.length>${hotAfter}
  UNION ALL
  SELECT r.base_offset,r.length,r.archive_key AS blob_key,r.created_at,
    ${registeredObjectKeySql('r.project_id', 'r.archive_key')} AS object_key
    FROM raw_archive_refs r WHERE r.project_id=${project} AND r.transcript_id=${transcript}
      AND r.source_kind='transcript' AND r.disposition='archived'
      AND r.base_offset>=COALESCE((SELECT MAX(k.base_offset) FROM raw_archive_refs k
        WHERE k.project_id=${coldProject} AND k.transcript_id=${coldTranscript} AND k.base_offset<=${coldAfter}),${coldAfter})
      AND r.base_offset+r.length>${coldAfter}`;
};

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

/** The prompt that opens a turn; delayed results retain their own prompt without changing the active turn. */
function turnOf(event: DerivedEvent): string | null {
    if (event.kind !== 'prompt' || event.opensTurn === false)
        return null;
    const named = event.payload.promptId;
    return typeof named === 'string' ? named : null;
}

/** A content-free description of the record where reading stopped. */
export interface ParseDiagnostic {
    branch: 'malformed_lines' | 'event_not_stored' | 'no_progress' | 'event_refused' | 'blob_absent' | 'record_too_large' | 'scheme_unread' | 'scheme_conflict' | 'record_kind_undeclared' | 'record_source_invalid' | 'record_identity_scheme_unsupported';
    offset: number;
    lineKind: string;
}

const LINE_KINDS = new Set(['user', 'assistant', 'attachment', 'session_meta', 'turn_context', 'event_msg', 'response_item', 'system', 'progress']);

/** Admits only bounded, content-free parser diagnostics. */
export function parseDiagnostic(value: unknown): ParseDiagnostic | undefined {
  if (!isBlock(value) || !['malformed_lines','event_not_stored','no_progress','event_refused','blob_absent','record_too_large','scheme_unread','scheme_conflict','record_kind_undeclared','record_source_invalid','record_identity_scheme_unsupported'].includes(String(value.branch))
    || !Number.isSafeInteger(value.offset) || Number(value.offset)<0) return undefined;
  return { branch: value.branch as ParseDiagnostic['branch'], offset: Number(value.offset),
    lineKind: typeof value.lineKind==='string' && (LINE_KINDS.has(value.lineKind)||value.lineKind==='tool_result') ? value.lineKind : 'unknown' };
}

function lineKind(line: ParsedLine | undefined): string {
    if (line === undefined)
        return 'unknown';
    const value = line.value;
    if (isBlock(value.message) && Array.isArray(value.message.content)
        && value.message.content.some((block: unknown) => isBlock(block) && block.type === 'tool_result'))
        return 'tool_result';
    return typeof value.type === 'string' && LINE_KINDS.has(value.type) ? value.type : 'unknown';
}

/** Stop this transcript where it stands and keep its recorded rows. */
async function stop(db: RelationalStore, target: ParseTarget, classifier: ParseFailure, now: number, refused?: {
    eventKind: string;
    refusal: Classifier;
} | {
    constraint_detail: string;
}, diagnostic: ParseDiagnostic = { branch: classifier === 'parse' ? 'no_progress' : classifier, offset: target.parsedOffset, lineKind: 'unknown' }): Promise<void> {
    return target.persistence.stop(classifier, now, diagnostic);
}

/**
 * Take a transcript out of the queue until it grows past the size this pass
 * read. A segment that lands while the pass runs has already grown it past
 * that size, so the transcript stays queued.
 */
async function awaitBytes(db: RelationalStore, target: ParseTarget, now: number): Promise<void> {
    return target.persistence.awaitBytes(now);
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
    for (let at = before.indexOf(0x0a); at >= 0; at = before.indexOf(0x0a, at + 1))
        n += 1;
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
        if (segment === undefined)
            return line;
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
async function skipUnheld(db: RelationalStore, target: ParseTarget, parser: NonNullable<ReturnType<typeof parserFor>>, nextHeld: number | null, recoveringHeader: boolean, now: number, calls: number): Promise<PassReport> {
    {
        await target.persistence.stop('blob_absent', now);
        return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'blob_absent' };
    }
}

/**
 * The unterminated tail of the held bytes, when it is a whole record: the
 * line it holds (null for one the formats skip, such as blank space or a
 * non-object), or null when it does not parse and so is still being written.
 */
function finalRecord(bytes: Uint8Array, offset: number): {
    line: ParsedLine | null;
} | null {
    const text = new TextDecoder('utf-8').decode(bytes).trim();
    if (text === '')
        return { line: null };
    let value: unknown;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    return { line: value !== null && typeof value === 'object' && !Array.isArray(value) ? { value: value as Record<string, unknown>, offset } : null };
}

/** The bytes of one segment from `from` on, by the stored object its registered blob names, or null when nothing registers or stores them. */
export async function segmentBytes(env: Pick<ServerEnv, 'blobs'>, objectKey: string | null, from: number): Promise<Uint8Array | null> {
    if (objectKey === null)
        return null;
    const held = await env.blobs.get(objectKey, from > 0 ? { range: { offset: from } } : undefined);
    if (held === null)
        return null;
    return new Uint8Array(await new Response(held.body).arrayBuffer());
}

/** What one pass may spend: store and blob calls, and the instant (on `clock`) past which it starts no more work. */
export interface PassLimits {
    calls: number;
    deadline: number;
    clock: () => number;
    completeFile?: boolean;
    statementBudget?: number;
}

export function terminalRule(target: ParseTarget, now: number, limits: PassLimits): ParserInput['terminal'] {
    if (limits.completeFile || target.imported)
        return 'complete_file';
    if (target.sessionEndedAt != null && target.sessionEndedAt <= now - SESSION_END_SETTLE_MS
        && (target.lastReceivedAt ?? now) <= now - SESSION_END_SETTLE_MS)
        return 'session_end';
    if ((target.lastReceivedAt ?? now) <= now - TRANSCRIPT_IDLE_MS)
        return 'idle';
    return target.turnEnded ? 'turn_end' : undefined;
}

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
    const startingStatements = remainingInvocationBudget(env.db)?.statements;
    const statementRoom = () => {
        const remaining = remainingInvocationBudget(env.db)?.statements;
        if (remaining === undefined || startingStatements === undefined)
            return Number.POSITIVE_INFINITY;
        return Math.min(remaining, (limits.statementBudget ?? Number.POSITIVE_INFINITY) - (startingStatements - remaining));
    };
    const parser = parserFor(target.agent);
    if (parser === null) {
        throw new Error('view_parser_absent');
    }
    // A transcript is read only by the derivation it is pinned to; one pinned to a scheme its parser does not derive
    // stops where it stands rather than naming its prompts another way. A declared agent's transcript with no pin is one
    // its session's group of transcripts could not be admitted to a single scheme for (`prompt-scheme.ts`).
    const scheme = target.scheme;
    if (scheme === null || !parser.schemes.includes(scheme)) {
        const branch = scheme === null && declaredScheme(target.agent) !== null ? 'scheme_conflict' : 'scheme_unread';
        await stop(env.db, target, 'parse', now, undefined, { branch, offset: target.parsedOffset, lineKind: 'unknown' });
        return { derived: 0, calls: 1, nextOffset: null, failure: 'parse' };
    }
    const recordScheme = target.recordScheme;
    if (!isRecordIdScheme(recordScheme)) {
        await stop(env.db, target, 'parse', now, undefined, { branch: 'record_identity_scheme_unsupported', offset: target.parsedOffset, lineKind: 'unknown' });
        return { derived: 0, calls: 1, nextOffset: null, failure: 'parse' };
    }
    // `calls` counts what THIS pass spends; the caller adds its own selection.
    let calls = 0;
    const terminalOnly = target.parsedOffset === target.size && terminalRule(target, now, limits) !== undefined;
    const failureOnlyContext = target.parserContext?.mycoParserFailure !== undefined
        && Object.keys(target.parserContext).length === 1;
    const needsHeader = parser.headerContext !== undefined && (target.parserContext == null || failureOnlyContext);
    const recoveringHeader = needsHeader && target.parsedOffset > 0;
    const readOffset = recoveringHeader ? 0 : target.parsedOffset;
    // The selection read the segments past the cursor with the transcript; a pass reading from elsewhere reads its own.
    let segments: SegmentRow[];
    if (target.segments !== undefined && readOffset === target.parsedOffset)
        segments = target.segments;
    else {
        segments = (await env.db
            .prepare(`SELECT * FROM (${segmentSource('?', '?', '?')}) ORDER BY base_offset LIMIT ${TRANSCRIPT_PARSE_SEGMENTS_PER_READ}`)
            .bind(target.projectId, target.transcriptId, readOffset, target.projectId, target.transcriptId, readOffset)
            .all<SegmentRow>()).results;
        calls += 1;
    }
    const taken = segmentsToRead(segments.map((s) => ({ baseOffset: s.base_offset, length: s.length, blobKey: s.blob_key, objectKey: s.object_key, createdAt: s.created_at })), readOffset, Number.POSITIVE_INFINITY, TRANSCRIPT_PARSE_SEGMENTS_PER_READ);
    if (taken.length === 0 && !terminalOnly)
        return skipUnheld(env.db, target, parser, segments[0]?.base_offset ?? null, recoveringHeader, now, calls);
    const windowBytes = VIEW_PARSE_BYTES_PER_READ;
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
            if (newline >= 0)
                unread = unread.subarray(0, newline + 1);
        }
        if (unreadBytes + unread.length > windowBytes) {
            const before = unread.lastIndexOf(0x0a, Math.max(0, windowBytes - unreadBytes - 1));
            const boundary = before >= 0 ? before : unread.indexOf(0x0a);
            if (boundary >= 0)
                unread = unread.subarray(0, boundary + 1);
        }
        const partialSegment = unread.length < bytes.length - Math.max(0, readOffset - from);
        unreadBytes += unread.length;
        if (unreadBytes > TRANSCRIPT_PARSE_RECORD_BYTES) {
            await stop(env.db, target, 'record_too_large', now);
            return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'record_too_large' };
        }
        chunks.push(unread);
        held.push({ start: from, lineBase: from === segment.baseOffset ? 0 : target.segmentLines!, createdAt: segment.createdAt, bytes });
        hasCompleteLine ||= unread.includes(0x0a);
        if ((unreadBytes >= windowBytes || partialSegment) && hasCompleteLine)
            break;
    }
    let joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        joined.set(chunk, at);
        at += chunk.length;
    }
    const readChunks = chunks.length;
    chunks = [];
    let split: ReturnType<typeof splitCompleteLines> | null = splitCompleteLines(joined, readOffset);
    if (split.malformed > TRANSCRIPT_PARSE_MALFORMED_LIMIT) {
        await stop(env.db, target, 'parse', now, undefined, { branch: 'malformed_lines', offset: split.malformedOffset ?? readOffset, lineKind: 'unknown' });
        return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'parse' };
    }
    if (split.malformed > 0)
        emit({ kind: 'transcript_lines_unreadable', projectId: target.projectId, transcriptId: target.transcriptId, lines: split.malformed });
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
    if (windowEnd === readOffset && !terminalOnly) {
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
    if (continued !== undefined && !isBlock(continued))
        throw new Error('Stored parser continuation is not an object');
    const transcriptMeta = stored?.mycoParserMeta !== undefined
        ? (isBlock(stored.mycoParserMeta) ? stored.mycoParserMeta : undefined)
        : stored === null || stored === undefined || failureOnlyContext ? parser.headerContext?.(windowLines) : continued === undefined ? withoutKey(stored, PROMPTS_DROPPED) : undefined;
    if (recoveringHeader) {
        {
            await target.persistence.header(transcriptMeta ?? {});
            return { derived: 0, calls: calls + 1, nextOffset: null, failure: null };
        }
    }
    let lines: ParsedLine[] | null = datedByPosition(windowLines, held);
    windowLines = null;
    {
        const received = await target.persistence.sourceTimes(lines.map(line => line.offset));
        lines = lines.map(line => ({ ...line, receivedAt: received.get(line.offset) }));
        if (lines.some(line => line.receivedAt === undefined))
            throw new Error('view_source_receipt_absent');
        calls++;
    }
    const chunkedState = continued?.chunked === true;
    const initialState: ParserState = chunkedState ? await (target.persistence.checkpoint(continued?.digest)) : structuredClone(continued ?? {});
    if (isBlock(stored?.mycoParserRepair))
        initialState.repair = stored.mycoParserRepair as ParserState['repair'];
    if (stored?.[PROMPTS_DROPPED] === 1)
        withoutPrompts(initialState);
    if (chunkedState)
        calls += 1;
    // A window's claims on harness keys are admitted before anything it derives is published: the session's key owners
    // decide, and a window that lost a claim to another transcript of the session is read again
    // under the owner that won, so its record is derived as the reuse it is.
    lines = lines.map((line, i) => ({ ...line, sourceEnd: lines![i + 1]?.offset ?? windowEnd }));
    let keys: ReadonlyMap<string, string> = new Map<string, string>();
  const readOwners = () => target.persistence.owners(keys);
  let owners: PromptOwners | undefined;
  const derive = async (): Promise<{ state: ParserState; input: ParserInput; parsed: DerivedEvent[] }> => {
    const state: ParserState = structuredClone(initialState);
    const input: ParserInput = { ...({view:true,identities:new Map<string,readonly string[]>()}), lines: lines!, sessionId: target.sessionId, transcriptId: target.transcriptId, recordScheme, scheme, now, openPromptId: target.openPromptId ?? undefined, transcriptMeta, state, owners,
      ...(target.role === undefined ? {} : { role: target.role }),
      terminal: terminalOnly || (limits.completeFile && windowEnd === target.size) ? terminalRule(target, now, limits) : undefined };
    return { state, input, parsed: await parser.parse(input) };
  };
  const admittedDerive = async () => {
    try { return await derive(); }
    catch (error) {
      if (!(error instanceof RecordIdentityError)) throw error;
      await stop(env.db, target, 'parse', now, undefined, { branch: error.code, offset: target.parsedOffset, lineKind: 'unknown' });
      calls += 1;
      return null;
    }
  };
  /** The current lines' derivation with their key claims admitted, or the report that ends the pass. */
  const claimedDerivation = async () => {
    keys = await parser.claimKeys?.(lines!, scheme, target.sessionId) ?? new Map<string, string>();
    owners = await readOwners();
    let claimed = await admittedDerive();
    if (claimed === null) return { derived: 0, calls, nextOffset: null, failure: 'parse' } satisfies PassReport;
    for (let round = 0; round < CLAIM_ROUNDS; round += 1) {
      const claims = keyClaims(claimed.parsed, keys, owners);
      if (claims.length === 0) break;
      // A claim and the reread after it are admitted only with the room the pass needs to publish and close behind them.
      if (pages(claims.length) + pages(keys.size) + PARSER_CHECKPOINT_HEADROOM + PARSER_CLOSE_HEADROOM > statementRoom())
        return { derived: 0, calls, nextOffset: null, failure: null } satisfies PassReport;
      await target.persistence.claim(claims);
      calls += 1;
      owners = await readOwners();
      if (claims.every((claim) => owners?.get(claim.key)?.record === claim.record)) break;
      claimed = await admittedDerive();
      if (claimed === null) return { derived: 0, calls, nextOffset: null, failure: 'parse' } satisfies PassReport;
    }
    return claimed;
  };
  let derivation = await claimedDerivation();
  if ('derived' in derivation) return derivation;
  // A window the writer cannot take is derived again over its first half of lines, from the state it began with: any
  // line boundary is a place the next pass can resume from, and the lines are already held.
  while(true){
    for(const event of derivation.parsed){
      const id=event.payload[event.kind==='tool.use'||event.kind==='tool.failure'?'toolCallId':event.kind==='plan'?'planKey':event.kind+'Id'];
      event.identity=derivation.input.identities?.get(String(id));
      event.sourceEnd??=lines.find(line=>line.offset>event.offset)?.offset??windowEnd;
    }
    const toPrompt=derivation.parsed.reduce((held,event)=>event.kind==='prompt'&&event.opensTurn!==false?turnOf(event):held,target.openPromptId);
    const used=await target.persistence.publish({events:derivation.parsed,state:derivation.state,metadata:transcriptMeta,to:windowEnd,lines:lines.length,segmentLines:segmentLinesAt(windowEnd,held),openPromptId:toPrompt,now,fidelity:parser.fidelity});
    if(used!==null)return {derived:derivation.parsed.length,calls:calls+used,nextOffset:windowEnd,failure:null};
    if(lines.length<2)return {derived:0,calls,nextOffset:null,failure:null};
    const kept=lines.length>>1;
    windowEnd=lines[kept]!.offset;
    lines=lines.slice(0,kept);
    const shorter=await claimedDerivation();
    if('derived' in shorter)return shorter;
    derivation=shorter;
  }
}

/** Which stored transcripts to read again: every one an agent's parser reads, or one session's. */
export type RereadSelector = {
    agent: string;
} | {
    projectId: string;
    sessionId: string;
};

/** Replays the retained transcript bytes into the current document generation. */
export async function rereadTranscripts(db: RelationalStore, selector: RereadSelector): Promise<number> {
 const where = 'agent' in selector ? {sql:'t.agent=?',params:[selector.agent]}
  : {sql:'t.project_id=? AND t.session_id=?',params:[selector.projectId,selector.sessionId]};
 const rows = await db.batch([
  db.prepare(`INSERT INTO transcript_publication(project_id,transcript_id,generation,session_id,published_offset,record_scheme,parser_version,updated_at)
    SELECT t.project_id,t.transcript_id,d.generation,t.session_id,COALESCE((SELECT MIN(base_offset) FROM (
      SELECT base_offset FROM transcript_segments WHERE project_id=t.project_id AND transcript_id=t.transcript_id
      UNION ALL SELECT base_offset FROM raw_archive_refs WHERE project_id=t.project_id AND transcript_id=t.transcript_id AND source_kind='transcript' AND disposition='archived')),0),
      COALESCE(t.record_identity_scheme,'legacy-session-v1'),0,0 FROM transcripts t JOIN session_documents d
      ON d.project_id=t.project_id AND d.session_id=t.session_id AND d.state='live' WHERE ${where.sql}
    ON CONFLICT(project_id,transcript_id,generation) DO UPDATE SET published_offset=excluded.published_offset,segment_lines=0,open_prompt_id=NULL,
      unfinished=0,reply_unfinished=0,reply_latest_at=NULL,state='active',failure=NULL,diagnostic=NULL,awaited_size=NULL,placed_records=NULL,placed_digest=NULL,parser_version=0
    RETURNING transcript_id`).bind(...where.params),
  db.prepare(`UPDATE session_documents AS d SET due_at=0 WHERE d.state='live' AND EXISTS (
    SELECT 1 FROM transcripts t WHERE t.project_id=d.project_id AND t.session_id=d.session_id AND ${where.sql})`).bind(...where.params),
 ]);
 return rows[0]!.results.length;
}

/** The transcripts that still owe a pass, and the bytes they have left to read; the half an import sent, apart. */
export interface TranscriptBacklog {
    transcripts: number;
    bytes: number;
    imported: {
        transcripts: number;
        bytes: number;
    };
}

/** The document publisher's pending transcript counts. */
export async function pendingTranscripts(db: RelationalStore, now=Date.now()): Promise<TranscriptBacklog> {
 const {pendingPublication}=await import('../read/document-status.js');
 const held=await pendingPublication(db,now);
 return {transcripts:held.transcripts,bytes:held.bytes,imported:{transcripts:held.imported.transcripts,bytes:held.imported.bytes}};
}

/** Transcripts of one Project the current parser stopped on a fault, and when the latest of them stopped. */
export interface StoppedTranscripts {
    projectId: string;
    transcripts: number;
    latestAt: number | null;
    /** How many stopped for each classifier (`ParseFailure`). */
    reasons: Record<string, number>;
    latestDiagnostic?: ParseDiagnostic;
}

/** Failed current document publications, grouped by their authenticated Project. */
export async function stoppedTranscripts(db: RelationalStore): Promise<StoppedTranscripts[]> {
 const rows=(await db.prepare(`SELECT p.project_id,p.failure,p.diagnostic,COUNT(*) n,MAX(p.updated_at) latest
  FROM transcript_publication p INDEXED BY idx_transcript_publication_failed JOIN session_documents d ON d.project_id=p.project_id AND d.session_id=p.session_id
    AND d.generation=p.generation AND d.state='live' JOIN projects pr ON pr.project_id=p.project_id AND pr.archived_at IS NULL
  WHERE p.state='failed' AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id=p.project_id AND t.session_id=p.session_id)
  GROUP BY p.project_id,p.failure`).all<{project_id:string;failure:string;diagnostic:string|null;n:number;latest:number}>()).results;
 const projects=new Map<string,StoppedTranscripts>();
 for(const row of rows){const held=projects.get(row.project_id)??{projectId:row.project_id,transcripts:0,latestAt:null,reasons:{}};
  held.transcripts+=Number(row.n);held.latestAt=Math.max(held.latestAt??0,row.latest);held.reasons[row.failure]=Number(row.n);
  const diagnostic=row.diagnostic===null?undefined:parseDiagnostic(JSON.parse(row.diagnostic));
  if(row.latest===held.latestAt){if(diagnostic===undefined)delete held.latestDiagnostic;else held.latestDiagnostic=diagnostic;}
  projects.set(row.project_id,held);}
 return [...projects.values()];
}

/**
 * Keys one statement reads or claims. A page travels as one JSON parameter read through `json_each`, so a window's
 * keys cost statements by the page, not by the key, and the statement binds three values whatever the page holds.
 */
const KEYS_PER_STATEMENT = 256;

/** Statements `count` keys take, a page each. */
const pages = (count: number): number => Math.ceil(count / KEYS_PER_STATEMENT);

/** Claim rounds a window takes at most: a lost claim reads it again once, and the reread claims nothing new. */
const CLAIM_ROUNDS = 3;

/** One record's claim on a harness key, as a window's parse made it. */
export interface KeyClaim {
    key: string;
    thread: string;
    record: string;
}

/**
 * The claims a parse made on keys no stored owner holds: each prompt it derived under a key's owner id
 * (`TranscriptParser.claimKeys`) for a key the window read no owner of.
 */
function keyClaims(events: readonly DerivedEvent[], keys: ReadonlyMap<string, string>, owners: PromptOwners | undefined): KeyClaim[] {
    const claims: KeyClaim[] = [];
    for (const event of events) {
        if (event.kind !== 'prompt')
            continue;
        const { sourceKey: key, sourceThread: thread, sourceRecord: record, promptId } = event.payload;
        if (typeof key !== 'string' || typeof thread !== 'string' || typeof record !== 'string')
            continue;
        if (keys.get(key) !== promptId || owners?.get(key) !== undefined)
            continue;
        claims.push({ key, thread, record });
    }
    return claims;
}
