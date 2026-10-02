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
 * error (with how long it asked callers to wait, where it said), or its daily quota is spent until `resetsAt`. `detail`
 * carries the provider's own words, bounded.
 */
export type EmbeddingFailure =
  | { kind: 'unreachable'; detail: string | null }
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; retryAfterMs: number | null }
  | { kind: 'quota'; resetsAt: number; detail: string };

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

/** What a Workers AI binding's error says about the failure: a spent daily quota, a timeout, or the binding's own words. */
export function workersAiFailure(error: unknown, timedOut: boolean, now: number): EmbeddingFailure {
  if (timedOut) return { kind: 'timeout' };
  const detail = failureDetail(error);
  if (detail !== null && WORKERS_AI_DAILY_QUOTA.test(detail)) return { kind: 'quota', resetsAt: nextUtcMidnight(now), detail };
  return { kind: 'unreachable', detail };
}

/** The milliseconds a `Retry-After` header asks for, or null where it names none that reads. */
export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export const embeddingText = (text: string): string => text.length <= EMBEDDING_TEXT_CHARS ? text : `${text.slice(0, EMBEDDING_TEXT_CHARS - 20)}\n[content truncated]`;

export function embeddingValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number')) throw new Error('embedding provider returned an invalid vector');
  normalizedVector(value);
  return value;
}
