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
export class EmbeddingUnavailable extends Error {}

export const embeddingText = (text: string): string => text.length <= EMBEDDING_TEXT_CHARS ? text : `${text.slice(0, EMBEDDING_TEXT_CHARS - 20)}\n[content truncated]`;

export function embeddingValues(value: unknown): number[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number')) throw new Error('embedding provider returned an invalid vector');
  normalizedVector(value);
  return value;
}
