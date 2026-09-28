import { normalizedVector } from './vectors.js';

export const EMBEDDING_TEXT_CHARS = 8000;
export const EMBEDDING_TIMEOUT_MS = 30_000;
/** A sent delete is confirmed this long after sending: past a hosted index's apply latency (p99 under two minutes) and any write already in flight, and inside the 15-minute wake floor. */
export const VECTOR_DELETE_CONFIRM_MS = 5 * 60 * 1000;
/** A delete that failed, or that its confirmation found unapplied, is sent again after this back-off. */
export const VECTOR_DELETE_RETRY_MS = 60 * 60 * 1000;
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
