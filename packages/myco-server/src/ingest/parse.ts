/**
 * Reading a transcript the Deployment holds, and deriving its rows.
 *
 * The member ships transcript bytes and the Deployment stores them opaquely.
 * This is where they become prompts, responses, tool calls and plans — the same
 * rows a hook event produces, through the same projections, so a row has one
 * shape whatever produced it.
 *
 * **The pass is bounded by outbound calls, not by bytes.** A hosted runtime
 * caps the calls one invocation may make, and store reads and blob reads both
 * count against that cap. Deriving each event through its own batch would
 * spend one call per event and exhaust the cap on a single turn, so a pass
 * collects up to `EVENTS_PER_BATCH` writes and lands them in ONE batch, and
 * stops once it has spent `CALLS_PER_PASS`. The tick that runs this also runs
 * the other jobs, which share the same budget.
 *
 * **A pass consumes only complete lines**, and the cursor advances to the byte
 * past the last one (`segments.ts`). Nothing is carried between passes but that
 * integer, so a pass that dies costs the work and none of the correctness.
 *
 * **The cursor never passes an event that did not land.** A derived event that
 * comes back unpersisted stops the transcript and stamps the failure. Advancing
 * regardless is the one defect that would lose rows silently and in bulk, which
 * is exactly what a transcript-first design cannot afford.
 */
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { emit, type Classifier } from '../telemetry.js';
import { uuidv5 } from '../hash.js';
import { planEventWrite, type EventWrite, type IngestResult } from './events.js';
import { idFields, kindSpec } from './kinds.js';
import { parserFor } from './parsers/registry.js';
import { isBlock, type DerivedEvent } from './parsers/index.js';
import { segmentsToRead, splitCompleteLines } from './segments.js';
import { MAX_BLOB_BYTES, SERVER_PROTOCOL } from '../constants.js';

/** Derived events collapsed into one database call. */
export const TRANSCRIPT_PARSE_EVENTS_PER_BATCH = 20;
/** Store and blob calls one pass may spend, well inside the tightest per-invocation cap a target imposes, which the other jobs share. */
export const TRANSCRIPT_PARSE_CALLS_PER_PASS = 12;
/** Normal read floor; an unfinished first record may use the bounded segment lookahead. */
export const TRANSCRIPT_PARSE_BYTES_PER_READ = 524_288;
/** Segments read in one pass. Bytes alone do not bound the READS: a transcript shipped in many small segments sits inside the byte budget while costing one read each. */
export const TRANSCRIPT_PARSE_SEGMENTS_PER_READ = 8;
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
export const PARSER_VERSION = 2;

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
export const TRANSCRIPT_PRODUCER = { adapter: 'transcript-parse', version: String(SERVER_PROTOCOL) } as const;

/**
 * Which transcripts still owe a pass: bytes unread, and either no failure or a
 * failure recorded against an older parser.
 *
 * Live transcripts are read before imported ones. `imported_at` is NULL for a
 * transcript a hook shipped, and SQLite orders NULLs first ascending, so
 * leading the sort with it puts live work ahead of a backfill without a second
 * job and without a second call budget — a backfill needs lower priority, not
 * more calls. Within the live half the order is unchanged.
 *
 * `nextTarget` and `pendingTranscriptBytes` share it. Counting work the
 * selection would not take keeps a Deployment awake for nothing; counting less
 * than it takes leaves a transcript a newer parser has reopened unread until
 * something else wakes the tick.
 */
export const PENDING_TRANSCRIPTS = `parsed_offset < size AND (parse_error IS NULL OR parser_version < ?)`;

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
}

function contextFromStored(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new Error('Stored transcript context is not JSON text');
  const context: unknown = JSON.parse(raw);
  if (!isBlock(context)) throw new Error('Stored transcript context is not an object');
  return context;
}

/** Why a transcript's parse stopped. Each is a stable classifier a dashboard and an operator read; none is a caller's text. */
export type ParseFailure = Extract<Classifier, 'parse'> | 'blob_absent';

/** The next transcript with unread bytes and no failure holding it, oldest receipt first. */
async function nextTarget(db: RelationalStore, now: number): Promise<ParseTarget | null> {
  const row = await db
    .prepare(`SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity, open_prompt_id, parser_context
                FROM transcripts
               WHERE ${PENDING_TRANSCRIPTS}
                 AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = transcripts.project_id AND t.session_id = transcripts.session_id)
               ORDER BY imported_at, last_received_at, transcript_id LIMIT 1`)
    .bind(PARSER_VERSION)
    .first<Record<string, unknown>>();
  if (row === null) return null;
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
  };
}

/**
 * The turn an event belongs to: its own id when it opens one, else the prompt
 * it names.
 *
 * This is what a pass records when it stops mid-turn, so the next pass derives
 * the remainder against the same prompt. Reading it from the events themselves
 * rather than from the store is what makes it exact: a lookup for "the
 * session's newest prompt" answers with whatever landed most recently, which a
 * member-shipped prompt or a subagent sibling can be.
 */
function turnOf(event: DerivedEvent): string | null {
  if (event.kind === 'prompt' && event.opensTurn === false) return null;
  // Every kind the parsers derive names its turn in the same field, a prompt
  // included: a prompt's `promptId` is its own.
  const named = event.payload.promptId;
  return typeof named === 'string' ? named : null;
}

/** Stop this transcript where it stands and say why. Its rows to this point are kept; later passes skip it until the failure is cleared. */
async function stop(db: RelationalStore, target: ParseTarget, classifier: ParseFailure, now: number): Promise<void> {
  await db
    .prepare(`UPDATE transcripts SET parse_error = ?, parse_failed_at = ?, parser_version = ? WHERE project_id = ? AND transcript_id = ?`)
    .bind(classifier, now, PARSER_VERSION, target.projectId, target.transcriptId)
    .run();
  emit({ kind: 'transcript_parse_failed', projectId: target.projectId, transcriptId: target.transcriptId, reason: classifier });
}

/** The bytes of one segment, or null when the store no longer holds them. */
async function segmentBytes(env: Pick<ServerEnv, 'blobs'>, projectId: string, blobKey: string): Promise<Uint8Array | null> {
  const held = await env.blobs.get(`${projectId}/${blobKey}`);
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


export interface PassReport {
  /** Events that landed this pass. */
  derived: number;
  /** Store and blob calls this pass spent, excluding the caller's own selection of it. */
  calls: number;
  /** The byte the cursor now stands at, or null when the pass did nothing. */
  nextOffset: number | null;
  failure: ParseFailure | null;
}

/**
 * One transcript, one pass.
 *
 * Reads the segments covering the cursor up to the read bound, derives what the
 * complete lines in them hold, lands the events in batches, and advances the
 * cursor to the byte past the last complete line — but only over events that
 * landed.
 */
export async function parseOnce(env: Pick<ServerEnv, 'db' | 'blobs'>, target: ParseTarget, now: number): Promise<PassReport> {
  const parser = parserFor(target.agent);
  if (parser === null) {
    // Nothing here reads this agent's format. The bytes are kept and the cursor
    // is moved to the end, so the transcript stops being offered to every pass.
    await env.db.prepare(`UPDATE transcripts SET parsed_offset = size, parsed_at = ?, parser_version = ? WHERE project_id = ? AND transcript_id = ?`)
      .bind(now, PARSER_VERSION, target.projectId, target.transcriptId).run();
    return { derived: 0, calls: 1, nextOffset: target.size, failure: null };
  }

  // `calls` counts what THIS pass spends; the caller adds its own selection.
  let calls = 0;
  const needsHeader = parser.headerContext !== undefined && target.parserContext == null;
  const recoveringHeader = needsHeader && target.parsedOffset > 0;
  const readOffset = recoveringHeader ? 0 : target.parsedOffset;
  const { results: segments } = await env.db
    .prepare(`SELECT base_offset, length, blob_key FROM transcript_segments
               WHERE project_id = ? AND transcript_id = ? AND base_offset + length > ?
               ORDER BY base_offset`)
    .bind(target.projectId, target.transcriptId, readOffset)
    .all<{ base_offset: number; length: number; blob_key: string }>();
  calls += 1;

  const taken = segmentsToRead(
    segments.map((s) => ({ baseOffset: s.base_offset, length: s.length, blobKey: s.blob_key })),
    readOffset, Number.POSITIVE_INFINITY, TRANSCRIPT_PARSE_SEGMENTS_PER_READ,
  );
  if (taken.length === 0) return { derived: 0, calls, nextOffset: null, failure: null };

  const chunks: Uint8Array[] = [];
  let unreadBytes = 0;
  let hasCompleteLine = false;
  let readEnd = readOffset;
  for (const segment of taken) {
    const bytes = await segmentBytes(env, target.projectId, segment.blobKey);
    calls += 1;
    if (bytes === null) {
      await stop(env.db, target, 'blob_absent', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'blob_absent' };
    }
    let unread = bytes.subarray(Math.max(0, readOffset - segment.baseOffset));
    if (unreadBytes >= TRANSCRIPT_PARSE_BYTES_PER_READ && !hasCompleteLine) {
      const newline = unread.indexOf(0x0a);
      if (newline >= 0) unread = unread.subarray(0, newline + 1);
    }
    unreadBytes += unread.length;
    if (unreadBytes > TRANSCRIPT_PARSE_RECORD_BYTES) {
      await stop(env.db, target, 'parse', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'parse' };
    }
    chunks.push(unread);
    hasCompleteLine ||= unread.includes(0x0a);
    readEnd = segment.baseOffset + segment.length;
    if (unreadBytes >= TRANSCRIPT_PARSE_BYTES_PER_READ && hasCompleteLine) break;
  }

  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length; }

  const split = splitCompleteLines(joined, readOffset);

  if (split.malformed > TRANSCRIPT_PARSE_MALFORMED_LIMIT) {
    await stop(env.db, target, 'parse', now);
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'parse' };
  }
  if (split.malformed > 0) emit({ kind: 'transcript_lines_unreadable', projectId: target.projectId, transcriptId: target.transcriptId, lines: split.malformed });
  if (split.lines.length === 0) {
    if (split.nextOffset === readOffset && chunks.length === TRANSCRIPT_PARSE_SEGMENTS_PER_READ && readEnd < target.size) {
      await stop(env.db, target, 'parse', now);
      return { derived: 0, calls: calls + 1, nextOffset: null, failure: 'parse' };
    }
    // No complete line in the window. A transcript whose tail is one unfinished
    // line waits for the segment that closes it rather than failing.
    return { derived: 0, calls, nextOffset: null, failure: null };
  }

  // The turn open where this window begins, as the pass that stopped here
  // recorded it. With it, an event derived after a break is identical to the
  // same event derived in one uninterrupted read, so a pass may stop anywhere
  // rather than only where a turn begins.
  const transcriptMeta = target.parserContext ?? parser.headerContext?.(split.lines);
  if (recoveringHeader) {
    await env.db.prepare('UPDATE transcripts SET parser_context = ? WHERE project_id = ? AND transcript_id = ?')
      .bind(JSON.stringify(transcriptMeta), target.projectId, target.transcriptId).run();
    return { derived: 0, calls: calls + 1, nextOffset: null, failure: null };
  }
  const events = await parser.parse({ lines: split.lines, sessionId: target.sessionId, now, openPromptId: target.openPromptId ?? undefined, transcriptMeta });
  const ctx = { projectId: target.projectId, machineId: target.machineId, tokenId: target.tokenId, bodyBytes: 0, now, writeOrigin: 'server' as const };

  let derived = 0;
  let cursor = split.nextOffset;
  // The turn open at the cursor, carried in and moved by every event landed.
  // A pass ends for either of two reasons — the call budget, or the window's
  // own bound — and BOTH can fall mid-turn: the member slices at 8 MiB and a
  // pass takes the first segment whole, so an ordinary boundary lands inside a
  // turn under either bound. Tracking it here rather than at the break is what
  // makes the two ends behave alike.
  let lastTurn: string | null = target.openPromptId;
  for (let i = 0; i < events.length; i += TRANSCRIPT_PARSE_EVENTS_PER_BATCH) {
    // The first group always runs, whatever the reads already cost, and the
    // budget ends a pass anywhere the cursor can actually move. A resumed pass
    // is handed the turn open at its start, so an event derived after a break
    // is identical to the same event derived without one; only the cursor
    // needs to advance, or the transcript would be re-read forever.
    if (i > 0 && calls >= TRANSCRIPT_PARSE_CALLS_PER_PASS && events[i].offset > target.parsedOffset) {
      cursor = events[i].offset;
      break;
    }
    const group = events.slice(i, i + TRANSCRIPT_PARSE_EVENTS_PER_BATCH);
    const writes: EventWrite[] = [];
    for (const event of group) {
      const planned = await planEventWrite(env.db, ctx, await envelopeFor(target, event));
      if (!planned.ok) {
        await stop(env.db, target, 'parse', now);
        return { derived, calls: calls + 1, nextOffset: null, failure: 'parse' };
      }
      writes.push(planned.write);
    }
    const results = await env.db.batch(writes.flatMap((w) => w.statements));
    calls += 1;

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

  // Uploaded bytes may end mid-turn; later segments continue the same prompt.
  const openPrompt = lastTurn;

  await env.db
    .prepare(`UPDATE transcripts SET parsed_offset = MAX(parsed_offset, ?), parsed_at = ?, parser_version = ?, fidelity = COALESCE(fidelity, ?), open_prompt_id = ?,
                 parser_context = COALESCE(parser_context, ?), parse_error = NULL, parse_failed_at = NULL
               WHERE project_id = ? AND transcript_id = ?`)
    .bind(cursor, now, PARSER_VERSION, parser.fidelity, openPrompt, transcriptMeta === undefined ? null : JSON.stringify(transcriptMeta), target.projectId, target.transcriptId)
    .run();
  calls += 1;

  emit({ kind: 'transcript_parsed', projectId: target.projectId, transcriptId: target.transcriptId, derived, offset: cursor });
  return { derived, calls, nextOffset: cursor, failure: null };
}

/** How many transcripts still owe a pass. What keeps a Deployment awake while a backlog stands. */
export async function pendingTranscriptBytes(db: RelationalStore): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ${PENDING_TRANSCRIPTS}`)
    .bind(PARSER_VERSION)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * How many of the pending transcripts arrived by import.
 *
 * Beside `pendingTranscriptBytes` rather than inside it: that count is what
 * keeps a Deployment awake for unread bytes, and a backfill must not. The tick
 * takes the difference for the live half and holds the Deployment at `active`
 * for that alone, leaving an import backlog to finish at `idle` as the
 * Deployment is used.
 */
export async function pendingImportedTranscripts(db: RelationalStore): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ${PENDING_TRANSCRIPTS} AND imported_at IS NOT NULL`)
    .bind(PARSER_VERSION)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** The job: passes over the transcripts that need one, until the call budget is spent. */
export async function parseTranscripts(env: ServerEnv, now: number): Promise<number> {
  let spent = 0;
  let derived = 0;
  while (spent < TRANSCRIPT_PARSE_CALLS_PER_PASS) {
    const target = await nextTarget(env.db, now);
    spent += 1;
    if (target === null) return derived;
    const report = await parseOnce(env, target, now);
    spent += report.calls;
    derived += report.derived;
    // A pass that moved nothing and failed nothing has no more to give this
    // tick; continuing would re-read the same bytes.
    if (report.nextOffset === null && report.failure === null) return derived;
  }
  return derived;
}
