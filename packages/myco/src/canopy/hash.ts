import { createHash } from 'node:crypto';

/** SHA-256 hex digest of a buffer. Used as the content_hash for scanner entries. */
export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Mechanical token estimate: one token per ~4 characters. Stable across
 * languages; deliberately ignores tokenizer-specific boundaries because we
 * want a cheap, deterministic heuristic that survives re-scans unchanged
 * when content is unchanged.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
