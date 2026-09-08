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
 * A parser is a pure function of the lines it is given. It holds no clock, no
 * store and no I/O, which is what lets one fixture prove one agent's format.
 *
 * Ids that a member also derives are derived here with the same parts through
 * `uuidv5`, which shares the member's namespace (`hash.ts`). A prompt the hook
 * shipped and the same prompt parsed out of the transcript are then one row
 * rather than two.
 */
import { uuidv5 } from '../../hash.js';
import type { Payload } from '../kinds.js';

/**
 * What a parser can see in its agent's transcript.
 *
 * `no_tool_results` is a property of the FORMAT, not of a file: Cursor's
 * transcript carries no tool results, so no parse of one can produce them, and
 * a session captured from it is structurally incomplete. Extraction excludes
 * such sessions; the dashboard shows them, labelled.
 */
export const FIDELITIES = ['full', 'no_tool_results'] as const;
export type Fidelity = (typeof FIDELITIES)[number];

/** One decoded transcript line and the byte offset it starts at. The offset is the parse cursor's unit and the derived event's identity, so it travels with the line. */
export interface ParsedLine {
  value: Record<string, unknown>;
  offset: number;
}

export interface ParserInput {
  lines: readonly ParsedLine[];
  sessionId: string;
  /** The instant a line with no readable timestamp is dated to, and the ceiling every line time is clamped to. */
  now: number;
}

/** A kind and a payload the catalogue admits, named by the byte offset that produced it. */
export interface DerivedEvent {
  kind: string;
  payload: Payload;
  createdAt: number;
  offset: number;
}

export interface TranscriptParser {
  agent: string;
  fidelity: Fidelity;
  /** Async to the extent the id derivations are: a parser reads no store and touches no clock. */
  parse(input: ParserInput): Promise<DerivedEvent[]>;
}

/** A prompt id a member also derives for a transcript record that declares a dedupe key. */
export const promptIdFor = (sessionId: string, dedupeKey: string): Promise<string> => uuidv5('queued-prompt', sessionId, dedupeKey);
/** A plan key a member also derives for a plan-tag envelope at a position in the session. Parts and their order are the member's (`planKeyForTag`, `packages/myco/src/member/envelope.ts:99`). */
export const planKeyForTag = (sessionId: string, tag: string, position: number): Promise<string> => uuidv5('plan-tag', sessionId, tag, String(position));
/** An attachment id a member also derives, keyed by the content rather than the position, so a replay names the same row. */
export const attachmentIdFor = (sessionId: string, sha256: string): Promise<string> => uuidv5('attachment', sessionId, sha256);
/** An id for a record the member has no derivation for: the transcript and the byte that produced it. */
export const offsetIdFor = (kind: string, transcriptId: string, offset: number): Promise<string> => uuidv5(kind, transcriptId, String(offset));

/** A line's own instant, never ahead of the server's clock: a transcript written by a fast clock cannot pin a projected column into the future. */
export function lineTime(value: Record<string, unknown>, now: number): number {
  const raw = value.timestamp;
  if (typeof raw !== 'string') return now;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) || parsed < 0 ? now : Math.min(parsed, now);
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

/** How much of a tool's output is kept inline; the catalogue's own bound on `output`. */
export const TOOL_OUTPUT_PREVIEW_CHARS = 4096;
