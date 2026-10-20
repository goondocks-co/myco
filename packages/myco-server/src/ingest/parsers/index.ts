/**
 * Per-agent transcript parsers: the on-disk transcript is the source of truth
 * for everything it contains, and this is where each agent's file format is
 * turned into the server's own closed kind catalogue.
 *
 * A parser returns KINDS AND PAYLOADS, never rows. Everything a parser produces
 * therefore passes `parsePayload` and lands through the same projections a
 * member's hook event lands in, so one row shape has one implementation and a
 * parser that invents a field is refused rather than stored.
 *
 * A parser derives events from supplied lines and continuation. It holds no
 * clock, store or I/O; a fixture exercises the format and its boundary state.
 *
 * Ids that a member also derives are derived here with the same parts through
 * `uuidv5`, which shares the member's namespace (`hash.ts`). A prompt the hook
 * shipped and the same prompt parsed out of the transcript are then one row
 * rather than two.
 */
import { utf8, uuidv5 } from '../../hash.js';
import { canonicalPromptId, type ClaudePromptShape, type ClaudeRecordKey, type OffsetPromptNamespace, type PromptIdScheme } from '@goondocks/myco-shared/prompt-identity';
import { canonicalRecordId, deriveLegacyRecordId, extractRecordSource, recordPlanCoordinate, RecordSourceAbsent, LEGACY_RECORD_ID_SCHEME, type RecordIdScheme, type RecordSourceRequest, type ReplySource } from '@goondocks/myco-shared/record-identity';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import type { TranscriptRole } from '@goondocks/myco-shared/member-protocol';
import { MAX_ID_CHARS, MAX_PAYLOAD_BYTES } from '../envelope.js';
import { kindSpec, type Payload } from '../kinds.js';

/**
 * What a parser can see in its agent's transcript.
 *
 * `no_tool_results` labels formats whose tools require supplementary hook
 * capture. The dashboard exposes this limitation on the transcript.
 */
export const FIDELITIES = ['full', 'no_tool_results'] as const;
export type Fidelity = (typeof FIDELITIES)[number];

/** One decoded transcript line and the byte offset it starts at. The offset is the parse cursor's unit and the derived event's identity, so it travels with the line. */
export interface ParsedLine {
  value: Record<string, unknown>;
  offset: number;
  /** Fallback time for an undated line whose first byte belongs to an imported segment. */
  undatedAt?: number;
}

export interface ParserInput {
  lines: readonly ParsedLine[];
  sessionId: string;
  transcriptId: string;
  recordScheme: RecordIdScheme;
  /** The transcript's pinned prompt identity scheme: the one derivation every prompt id of this transcript is made by. */
  scheme: PromptIdScheme;
  /** The ceiling for line timestamps and the fallback for undated live lines. */
  now: number;
  /**
   * The turn open where this window begins, when it began before it.
   *
   * A window starting mid-turn does not contain the prompt that turn carries,
   * and events derived without it would differ from the same events derived
   * with it — the same rows, refused against what an earlier pass already
   * wrote. Carrying the open prompt in makes a resumed derivation identical to
   * an uninterrupted one, which is what lets a pass stop anywhere.
   */
  openPromptId?: string;
  transcriptMeta?: Record<string, unknown>;
  /** Mutable continuation committed at the same byte as the parse cursor. Absent for a complete-file parse. */
  state?: ParserState;
  /** A source lifecycle boundary closes the retained turn and unanswered calls. */
  terminal?: 'session_end' | 'idle' | 'complete_file' | 'turn_end';
  /**
   * Who already owns each harness key this window claims, as the store holds it (`TranscriptParser.claimKeys`), read
   * before the pass and never written by a parse: a record a parse claims for itself lives in that parse alone, so
   * every replay of a prefix of the window decides as the first one did.
   */
  owners?: PromptOwners;
  /**
   * The keys this traversal has claimed so far, by the record that claimed each: one map per traversal of a window,
   * made by whoever walks it (`incremental.ts`), so a replay of a prefix never sees a claim a later record made.
   */
  claims?: Map<string, string>;
  /** How the transcript is registered: the session's own, or a delegated agent's. Absent where no registration names it. */
  role?: TranscriptRole;
}

/** The record that owns a harness key, by its thread and uuid. */
export interface PromptOwner { thread: string; record: string }
/** Read-only owners of harness keys, as a pass is handed them. */
export interface PromptOwners { get(key: string): PromptOwner | undefined }
/** The owners a pass reads, behind an accessor no parse can write through. */
export function promptOwners(entries: Iterable<readonly [string, PromptOwner]>): PromptOwners {
  const held = new Map<string, PromptOwner>([...entries].map(([key, owner]) => [key, Object.freeze({ ...owner })]));
  return Object.freeze({ get: (key: string) => held.get(key) });
}

export interface PendingCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  promptId?: string;
  createdAt: number;
  offset: number;
}

export interface ParserState {
  pending?: Record<string, PendingCall>;
  reply?: { parts: ReplyPart[]; promptId?: string; chars: number; bytes: number };
  planPosition?: number;
  legacyReplies?: { until: number; remaining?: string; promptId?: string };
  /** The Codex turn the cursor stands in under `codex-turn-v1`, and whether its opener has been named. */
  turn?: { id: string; opened: boolean };
  repair?: { version: number; fromVersion: number; status: 'replaying' | 'raw_absent' | 'raw_prefix_pruned' | 'raw_gap' };
}

/**
 * A continuation resumed under another prompt generation without the bytes behind its cursor: every prompt it carries
 * is named by the earlier rule, so each is dropped. Pending calls and a held reply keep everything else, so a later
 * result still closes its call and the reply still lands, each naming no prompt.
 */
export function withoutPrompts(state: ParserState): void {
  for (const call of Object.values(state.pending ?? {})) delete call.promptId;
  if (state.reply !== undefined) delete state.reply.promptId;
  if (state.legacyReplies !== undefined) delete state.legacyReplies.promptId;
}

/** A declared complete transcript records calls whose results never arrived. */
export function unfinishedCalls(pending: Iterable<readonly [string, PendingCall]>, errorMessage = 'tool call has no result in the transcript'): DerivedEvent[] {
  return [...pending].map(([key, call]) => ({
    kind: 'tool.failure', source: { key, block: 0 }, legacyId: call.toolCallId,
    payload: { toolCallId: call.toolCallId, promptId: call.promptId, toolName: call.toolName, input: call.input,
      success: false, errorMessage },
    createdAt: call.createdAt, offset: call.offset,
  }));
}

/** An output retains the source call identity after a terminal or count-bound flush. */
export async function callForResult(input: ParserInput, agent: string, source: ReplySource, pending: Map<string, PendingCall>, at: { offset: number; createdAt: number; promptId?: string }): Promise<PendingCall> {
  const sourceId = 'key' in source ? source.key : undefined;
  const held = sourceId === undefined ? undefined : pending.get(sourceId);
  if (sourceId !== undefined) pending.delete(sourceId);
  return held ?? { toolCallId: await recordId(input, agent, { kind: 'tool-call', source, offset: at.offset }), toolName: 'unknown', input: {}, ...at };
}

const recordDeclaration = (agent: string) => CAPTURE_RULE_BUNDLES.find(bundle => bundle.name === agent)?.recordIdentity;

/** The manifest's admitted source facts for one parser-emitted record. */
export function recordSource(input: ParserInput, agent: string, request: Omit<RecordSourceRequest, 'declaration' | 'scheme'>): ReplySource {
  return extractRecordSource({ ...request, declaration: recordDeclaration(agent),
    scheme: input.recordScheme });
}

/** A keyed tool shape with no source key emits no invocation or result. */
export function optionalRecordSource(input: ParserInput, agent: string, request: Omit<RecordSourceRequest, 'declaration' | 'scheme'>): ReplySource | undefined {
  try { return recordSource(input, agent, request); }
  catch (error) {
    if (error instanceof RecordSourceAbsent) return undefined;
    throw error;
  }
}

type RecordFacts = { source: ReplySource; offset: number } & (
  | { kind: 'response' | 'tool-call' }
  | { kind: 'plan'; tag: string; coordinate: readonly (string | number)[]; legacyPosition: number }
);
/** The registry mints a record after the parser extracts its declared source. */
export async function recordId(input: ParserInput, agent: string, request: RecordFacts): Promise<string> {
  return canonicalRecordId(uuidv5, { ...request, scheme: input.recordScheme, sessionId: input.sessionId, transcriptId: input.transcriptId, agent });
}

/** The compatibility identity of the same extracted record. */
export async function legacyRecordId(input: ParserInput, request: RecordFacts): Promise<string> {
  return deriveLegacyRecordId(uuidv5, { ...request, sessionId: input.sessionId });
}

/** Pending calls and plan positions survive read boundaries; a read boundary never closes a call. */
export function parserContinuation(input: ParserInput): {
  pending: Map<string, PendingCall>; position: number; save(position: number): void;
} {
  const pending = new Map(Object.entries(input.state?.pending ?? {}));
  return {
    pending, position: input.state?.planPosition ?? 0,
    save(position) {
      if (input.state === undefined) return;
      input.state.pending = Object.fromEntries(pending);
      if (input.recordScheme === LEGACY_RECORD_ID_SCHEME) input.state.planPosition = position;
    },
  };
}

/** A kind and a payload the catalogue admits, named by the byte offset that produced it. */
export interface DerivedEvent {
  kind: string;
  payload: Payload;
  createdAt: number;
  offset: number;
  /** False when a captured prompt supplies context without opening an assistant turn. */
  opensTurn?: boolean;
  source?: ReplySource;
  legacyId?: string;
  coordinate?: readonly (string | number)[];
}

/**
 * How an agent carries one conversation forward under a new session id.
 *
 * Claude Code does it on a compaction rollover and on a fork: it rewrites the
 * current id on every line and leaves the predecessor's only on the records
 * written before the switch. Those earlier records are the PREDECESSOR's turns,
 * and deriving them into the continued session would attribute one session's
 * work to another.
 */
export interface Continuation {
  /** Where a record names the session it belonged to. */
  parentSessionIdPath: string;
  /** Flags marking a record that belongs to this session wherever it sits. */
  markerPaths: readonly string[];
}

export interface TranscriptParser {
  agent: string;
  fidelity: Fidelity;
  /** Declared by an agent that continues a conversation under a new id; absent for one that does not. */
  continuation?: Continuation;
  /** A vendor record that explicitly closes the assistant turn. */
  endsTurn?(value: Record<string, unknown>): boolean;
  /** Metadata from the beginning of the recording, retained across parse windows. */
  headerContext?(lines: readonly ParsedLine[]): Record<string, unknown>;
  /**
   * The assistant-text wrappers a plan arrives in for this agent.
   *
   * Declared per agent rather than guessed, and held equal to the agent's own
   * manifest by a gate in `tests/meta/`: the member scans exactly these tags, so
   * a server list that drifted would derive plans the member never sends, or
   * miss the ones it does.
   */
  planTags: readonly string[];
  /** The field of a line holding its own time, where it is not `timestamp`. */
  lineTimeField?: string;
  /** The prompt identity schemes this parser derives by; a transcript pinned to another is not read (`parse.ts`). */
  schemes: readonly PromptIdScheme[];
  /**
   * Under a scheme whose harness key a record may claim, the keys a window's records could claim, and the prompt id of
   * each key's owner: what the pass reads stored owners for (`ParserInput.owners`). Pure, like `parse`.
   */
  claimKeys?(lines: readonly ParsedLine[], scheme: PromptIdScheme, sessionId: string): Promise<ReadonlyMap<string, string>>;
  /** Async to the extent the id derivations are: a parser reads no store and touches no clock. */
  parse(input: ParserInput): Promise<DerivedEvent[]>;
}

/**
 * A prompt id a member also derives for a transcript record that declares a
 * dedupe key.
 *
 * The key is `<shape>|<value>`, not the bare value: the member's walker scopes
 * a dedupe identity by the shape that matched it (`capture/prompt-kind.ts`
 * `toKey`), so two shapes reading the same field cannot collide. A parser that
 * passed the bare value would derive a different id for the same prompt and the
 * two paths would each write their own row.
 */
export const promptIdFor = async (sessionId: string, shape: ClaudePromptShape, value: string): Promise<string> =>
  canonicalPromptId(uuidv5, { scheme: 'claude-v1', sessionId, shape, key: value });
/** A claude-v2 prompt id: a key's owner, a queued command, or any other kept record by its thread and uuid. */
export const claudeRecordIdFor = async (sessionId: string, record: ClaudeRecordKey): Promise<string> =>
  canonicalPromptId(uuidv5, { scheme: 'claude-v2', sessionId, record });
/** A prompt id a transcript names by its byte position, under its parser's own prompt namespace. */
export const promptIdAtOffset = async (namespace: OffsetPromptNamespace, sessionId: string, offset: number): Promise<string> =>
  canonicalPromptId(uuidv5, { scheme: 'offset-v1', namespace, sessionId, offset });
/** The instant a line's own time field carries, never ahead of the server's clock; null for a line that carries none. */
export function datedAt(raw: unknown, now: number): number | null {
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) || parsed < 0 ? null : Math.min(parsed, now);
}

/** A line's own instant, never ahead of the server's clock. An undated line takes `undatedAt`, else `now`, clamped the same way. */
export function lineTime(value: Record<string, unknown>, now: number, undatedAt?: number): number {
  return datedAt(value.timestamp, now) ?? Math.min(undatedAt ?? now, now);
}

/** The text of a content field that is either a plain string or an array of typed blocks. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: string; text: string } => isBlock(b) && b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n\n');
}

export const isBlock = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const blocksOf = (content: unknown): Record<string, unknown>[] => (Array.isArray(content) ? content.filter(isBlock) : []);
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The value at a dotted path, or undefined. */
export function atPath(value: Record<string, unknown>, path: string): unknown {
  let held: unknown = value;
  for (const segment of path.split('.')) {
    if (held === null || typeof held !== 'object') return undefined;
    held = (held as Record<string, unknown>)[segment];
  }
  return held;
}

/**
 * The lines that are THIS session's own turns: everything after the last record
 * naming a predecessor, plus every marker record wherever it sits.
 *
 * Byte for byte the member's rule (`capture/session-continuation.ts`
 * `eventsOwnedBySession`). The two paths must agree on which session a turn
 * belongs to, or a continued transcript derives its predecessor's prompts into
 * the wrong session.
 */
export function ownedLines(lines: readonly ParsedLine[], sessionId: string, continuation: Continuation | undefined): ParsedLine[] {
  if (continuation === undefined) return [...lines];
  let boundary = -1;
  lines.forEach((line, index) => {
    const named = atPath(line.value, continuation.parentSessionIdPath);
    if (typeof named === 'string' && named !== '' && named !== sessionId) boundary = index;
  });
  if (boundary < 0) return [...lines];
  return lines.filter((line, index) => index > boundary || continuation.markerPaths.some((path) => atPath(line.value, path) === true));
}

/** One assistant message of a turn, with its transcript offset and time. */
export interface ReplyPart {
  text: string;
  offset: number;
  createdAt: number;
  source?: ReplySource;
}

/** What separates the messages of one turn in its response text. */
export const REPLY_SEPARATOR = '\n\n';

/** What stands in for the end of a single message too long for one response. */
export const truncationMarker = (dropped: number): string => `${REPLY_SEPARATOR}[${dropped} more characters not kept]`;

/** The largest `response.text` the catalogue admits, in characters. */
function responseTextChars(): number {
  const bound = kindSpec({ kind: 'response' })?.fields.text?.bound;
  if (bound?.type !== 'string') throw new Error('the catalogue holds no string bound on response.text');
  return bound.max;
}

/**
 * The bytes a response's text may take in its payload: the envelope's payload
 * bound, less the rest of a response payload with both ids at their longest.
 */
const RESPONSE_TEXT_BYTES = MAX_PAYLOAD_BYTES - utf8(JSON.stringify({ responseId: 'x'.repeat(MAX_ID_CHARS), promptId: 'x'.repeat(MAX_ID_CHARS), text: '' })).byteLength;

/** The bytes `text` takes inside a JSON payload, escapes included and quotes not. */
const payloadBytes = (text: string): number => utf8(JSON.stringify(text)).byteLength - 2;

/** How far a response's text may run: both the catalogue's character bound and the payload's byte bound hold. */
export interface ResponseBound {
  chars: number;
  bytes: number;
}

export const responseBound = (): ResponseBound => ({ chars: responseTextChars(), bytes: RESPONSE_TEXT_BYTES });

const fits = (text: string, bound: ResponseBound): boolean => text.length <= bound.chars && payloadBytes(text) <= bound.bytes;

/** The longest start of `text`, marker included, that fits the bound, never ending inside a surrogate pair. */
function truncated(text: string, bound: ResponseBound): string {
  let low = 0;
  let high = text.length;
  const withMarker = (n: number): string => {
    const cut = n > 0 && /[\uD800-\uDBFF]/.test(text[n - 1]) ? n - 1 : n;
    return text.slice(0, cut) + truncationMarker(text.length - cut);
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(withMarker(mid), bound)) low = mid;
    else high = mid - 1;
  }
  return withMarker(low);
}

/**
 * One turn's assistant messages as the responses that hold them.
 *
 * The supplied message parts join into one response. When the joined
 * text would pass the catalogue's bound on `response.text` or the payload's
 * byte bound, the reply is split at message boundaries instead: each response
 * holds as many whole messages as fit and is named by its first message's
 * offset, so a reply that fits keeps the id and text it has always had. The
 * responses, joined by the separator, are the joined text exactly. A single
 * message too long for any response is cut short with a marker saying how
 * much it leaves out.
 */
export function replyChunks(parts: readonly ReplyPart[], bound: ResponseBound = responseBound()): ReplyPart[] {
  const kept = parts.filter((p) => p.text.trim() !== '');
  if (kept.length === 0) return [];
  const last = kept.length - 1;
  // JSON escapes character by character, so a joined text's payload bytes are
  // the sum of its pieces' and the separators': each piece is measured once.
  const pieces = kept.map((p, i) => {
    const text = i === 0 && i === last ? p.text.trim() : i === 0 ? p.text.trimStart() : i === last ? p.text.trimEnd() : p.text;
    return { part: { ...p, text }, chars: text.length, bytes: payloadBytes(text) };
  });
  const sep = { chars: REPLY_SEPARATOR.length, bytes: payloadBytes(REPLY_SEPARATOR) };
  const within = (chars: number, bytes: number): boolean => chars <= bound.chars && bytes <= bound.bytes;
  const chunks: ReplyPart[] = [];
  let open: { texts: string[]; first: ReplyPart; chars: number; bytes: number } | null = null;
  const close = (): void => {
    if (open !== null) chunks.push({ ...open.first, text: open.texts.join(REPLY_SEPARATOR) });
    open = null;
  };
  for (const { part, chars, bytes } of pieces) {
    if (open !== null && within(open.chars + sep.chars + chars, open.bytes + sep.bytes + bytes)) {
      open.texts.push(part.text);
      open.chars += sep.chars + chars;
      open.bytes += sep.bytes + bytes;
      continue;
    }
    close();
    const text = within(chars, bytes) ? part.text : truncated(part.text, bound);
    open = { texts: [text], first: part, chars: text.length, bytes: payloadBytes(text) };
  }
  close();
  return chunks;
}

/** How much of a tool's output is kept inline; the catalogue's own bound on `output`. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 4096;

/** A plan-tag envelope's body, non-greedy so consecutive envelopes stay separate; the optional newline either side is the member's own shape (`packages/myco/src/plans/tag-envelopes.ts`). */
export const planEnvelope = (tag: string): RegExp => new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`, 'g');

/** The first Markdown heading of a body, for a plan the transcript gives no title. */
export function firstHeading(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) return m[1].slice(0, 256);
  }
  return undefined;
}

/** The plans in each declared envelope, named by its source-record coordinate. */
export async function plansInText(
  text: string, tags: readonly string[], input: ParserInput, agent: string, record: Record<string, unknown>,
  at: { promptId?: string; offset: number; createdAt: number }, from: number, block?: number,
): Promise<{ events: DerivedEvent[]; next: number }> {
  const events: DerivedEvent[] = [];
  let position = from;
  for (const tag of tags) {
    const re = planEnvelope(tag);
    let match: RegExpExecArray | null;
    let matchIndex = 0;
    while ((match = re.exec(text)) !== null) {
      const rawMatchIndex = matchIndex++;
      const content = match[1].trim();
      if (content === '') continue;
      const source = recordSource(input, agent, { kind: 'plan', record, block: block ?? 0 });
      const coordinate = recordPlanCoordinate({ declaration: recordDeclaration(agent),
        scheme: input.recordScheme, source, matchIndex: rawMatchIndex });
      const plan = { tag, coordinate, legacyPosition: position };
      events.push({
        kind: 'plan', source, coordinate, legacyId: await legacyRecordId(input, { kind: 'plan', source, offset: at.offset, ...plan }),
        payload: {
          planKey: await recordId(input, agent, { kind: 'plan', source, offset: at.offset, ...plan }),
          promptId: at.promptId,
          title: firstHeading(content),
          content,
          status: 'active',
          originPath: `transcript:${tag}`,
          tags: [tag],
          source: 'tag',
        },
        createdAt: at.createdAt,
        offset: at.offset,
      });
      position += 1;
    }
  }
  return { events, next: position };
}
