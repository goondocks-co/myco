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
  planPosition?: number;
  legacyReplies?: { until: number; remaining?: string; promptId?: string };
}

/** A declared complete transcript records calls whose results never arrived. */
export function unfinishedCalls(pending: Iterable<PendingCall>): DerivedEvent[] {
  return [...pending].map((call) => ({
    kind: 'tool.failure',
    payload: { toolCallId: call.toolCallId, promptId: call.promptId, toolName: call.toolName, input: call.input,
      success: false, errorMessage: 'tool call has no result in the transcript' },
    createdAt: call.createdAt, offset: call.offset,
  }));
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
      input.state.planPosition = position;
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
export const promptIdFor = (sessionId: string, shape: string, value: string): Promise<string> =>
  uuidv5('queued-prompt', sessionId, `${shape}|${value}`);
/** A plan key a member also derives for a plan-tag envelope at a position in the session. Parts and their order are the member's (`planKeyForTag`, `packages/myco/src/member/envelope.ts:99`). */
export const planKeyForTag = (sessionId: string, tag: string, position: number): Promise<string> => uuidv5('plan-tag', sessionId, tag, String(position));
/** An attachment id a member also derives, keyed by the content rather than the position, so a replay names the same row. */
export const attachmentIdFor = (sessionId: string, sha256: string): Promise<string> => uuidv5('attachment', sessionId, sha256);
/** An id for a record the member has no derivation for: the transcript and the byte that produced it. */
export const offsetIdFor = (kind: string, transcriptId: string, offset: number): Promise<string> => uuidv5(kind, transcriptId, String(offset));

/** A line's own instant, never ahead of the server's clock. An undated line takes `undatedAt`, else `now`, clamped the same way. */
export function lineTime(value: Record<string, unknown>, now: number, undatedAt?: number): number {
  const undated = Math.min(undatedAt ?? now, now);
  const raw = value.timestamp;
  if (typeof raw !== 'string') return undated;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) || parsed < 0 ? undated : Math.min(parsed, now);
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
}

/** What separates the messages of one turn in its response text. */
export const REPLY_SEPARATOR = '\n\n';

/** What stands in for the end of a single message too long for one response. */
export const truncationMarker = (dropped: number): string => `${REPLY_SEPARATOR}[${dropped} more characters not kept]`;

/** The largest `response.text` the catalogue admits, in characters. */
function responseTextChars(): number {
  const bound = kindSpec('response')?.fields.text?.bound;
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

/**
 * The plans an assistant reply carries, one per tag envelope.
 *
 * Shared by every parser: the tags differ per agent and the envelope shape does
 * not, and the key each plan takes is the member's own derivation over the tag
 * and the plan's position in the session — so a plan the hook shipped and the
 * same plan parsed out of the transcript are one row.
 */
export async function plansInText(
  text: string, tags: readonly string[], sessionId: string, at: { promptId?: string; offset: number; createdAt: number }, from: number,
): Promise<{ events: DerivedEvent[]; next: number }> {
  const events: DerivedEvent[] = [];
  let position = from;
  for (const tag of tags) {
    const re = planEnvelope(tag);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const content = match[1].trim();
      if (content === '') continue;
      events.push({
        kind: 'plan',
        payload: {
          planKey: await planKeyForTag(sessionId, tag, position),
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
