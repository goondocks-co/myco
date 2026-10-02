import { normalizedVector } from './vectors.js';

export const EMBEDDING_TEXT_CHARS = 8000;
export const EMBEDDING_TIMEOUT_MS = 30_000;
/** A sent delete is confirmed this long after sending: past a hosted index's apply latency (p99 under two minutes) plus the write bound below, and inside the 15-minute wake floor. */
export const VECTOR_DELETE_CONFIRM_MS = 5 * 60 * 1000;
/** A vector write or delete that has not settled by this bound fails its step. Well inside the confirmation window. */
export const VECTOR_WRITE_TIMEOUT_MS = 60_000;
/** A delete that failed, or that its confirmation found unapplied, is sent again after this back-off. */
export const VECTOR_DELETE_RETRY_MS = 60 * 60 * 1000;
/**
 * A written vector the vector store still does not return this long after its write is taken as lost and written
 * again. Fifteen times a hosted index's p99 apply latency (under two minutes) plus the write bound, so a vector that is
 * merely slow to appear is never written twice; spore calibration waits on a vector for at most this long.
 */
export const VECTOR_LOST_MS = 30 * 60 * 1000;
/** A lost spore vector is written again at most this many times; after that the spore stays out of calibration and is reported. */
export const VECTOR_REWRITE_LIMIT = 2;
export interface EmbeddingProvider {
  modelKey: string;
  embed(text: string): Promise<number[]>;
}
/**
 * Why a provider could not compute a vector: it could not be reached, it did not answer in time, it answered an HTTP
 * error (with how long it asked callers to wait, where it said), its daily quota is spent until `resetsAt`, or it
 * refused this text as input. `detail` carries the provider's own words, bounded.
 */
export type EmbeddingFailure =
  | { kind: 'unreachable'; detail: string | null }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; retryAfterMs: number | null; detail: string | null }
  | { kind: 'quota'; resetsAt: number; detail: string }
  | { kind: 'input'; detail: string | null };

export class EmbeddingUnavailable extends Error {
  constructor(message: string, readonly failure: EmbeddingFailure = { kind: 'unreachable', detail: null }) { super(message); }
}

/** The most of a provider's own error words a failure carries. */
export const FAILURE_DETAIL_CHARS = 200;

/** An error's own words, bounded, or null where it has none. */
export const failureDetail = (error: unknown): string | null => {
  const words = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return words.trim() === '' ? null : words.trim().slice(0, FAILURE_DETAIL_CHARS);
};

/** Workers AI's answer when an account's daily free allocation is spent: error 4006, naming the daily allocation of neurons. */
const WORKERS_AI_DAILY_QUOTA = /\b4006\b|daily free allocation/i;

/** The next midnight UTC after `now`, when a Workers AI daily allocation is renewed. */
export const nextUtcMidnight = (now: number): number => {
  const day = new Date(now);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1);
};

/** Workers AI's answer when it refuses one input: errors 3010 and 5006, or words naming the input as invalid or too long. */
const WORKERS_AI_INPUT = /\b(3010|5006)\b|invalid or incomplete input|input (is )?too long|too many tokens|exceeds? the (maximum|context)/i;

/**
 * What a Workers AI binding's error says about the failure: a spent daily quota, a timeout, an input it refuses, or the
 * binding's own words.
 */
export function workersAiFailure(error: unknown, timedOut: boolean, now: number): EmbeddingFailure {
  if (timedOut) return { kind: 'timeout' };
  const detail = failureDetail(error);
  if (detail !== null && WORKERS_AI_DAILY_QUOTA.test(detail)) return { kind: 'quota', resetsAt: nextUtcMidnight(now), detail };
  if (detail !== null && WORKERS_AI_INPUT.test(detail)) return { kind: 'input', detail };
  return { kind: 'unreachable', detail };
}

/** HTTP statuses a provider answers when it refuses the text it is sent rather than the request. */
const INPUT_STATUSES: ReadonlySet<number> = new Set([400, 413, 422]);

/**
 * Why a provider refused this text as input, in the reader's words, or null where the failure is not about the input:
 * the source is passed over under that model rather than holding embedding up.
 */
export function inputRefusal(error: unknown): string | null {
  if (!(error instanceof EmbeddingUnavailable)) return null;
  const failure = error.failure;
  const said = (detail: string | null) => detail === null ? '' : ` (“${detail}”)`;
  if (failure.kind === 'input') return `the model refused its text${said(failure.detail)}`;
  if (failure.kind === 'http' && INPUT_STATUSES.has(failure.status)) return `the model refused its text with HTTP ${failure.status}${said(failure.detail)}`;
  return null;
}

/** The longest wait a provider's `Retry-After` is honoured for. */
export const RETRY_AFTER_MAX_MS = 6 * 60 * 60_000;

/** The milliseconds a `Retry-After` header asks for, at most `RETRY_AFTER_MAX_MS`, or null where it names none that reads. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  const asked = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isNaN(Date.parse(header)) ? null : Math.max(0, Date.parse(header) - now);
  return asked === null ? null : Math.min(asked, RETRY_AFTER_MAX_MS);
}

export const embeddingText = (text: string): string => text.length <= EMBEDDING_TEXT_CHARS ? text : `${text.slice(0, EMBEDDING_TEXT_CHARS - 20)}\n[content truncated]`;

export function embeddingValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number')) throw new Error('embedding provider returned an invalid vector');
  normalizedVector(value);
  return value;
}
