/**
 * The rate limiter for a deployment that is one process.
 *
 * Two counter maps approximate a sliding window: the current period and the one
 * before it, weighted by how far into the current period the request arrives. A
 * plain fixed window admits twice the configured rate across a boundary, which for
 * the source bucket means a caller can double the pre-authentication allowance by
 * timing requests around it.
 *
 * Rolling the window swaps the two maps, so reclaiming elapsed counters costs one
 * assignment rather than a walk of every key seen. A walk per miss makes the cost
 * quadratic in distinct keys, which a caller varying its key on every request
 * controls directly.
 *
 * The key space is bounded and fails CLOSED: past the ceiling a key with no
 * counter is refused rather than admitted, so exhausting memory is never a way to
 * obtain unmetered traffic.
 */
import type { RateLimiter } from '../../core/adapters.js';

export interface WindowOptions {
  /** Requests admitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  periodMs: number;
  /** Distinct keys tracked at once; a new key past this is refused. */
  maxKeys?: number;
  /** Injected so the limiter is testable on a controlled clock, matching how the core takes `now`. */
  now?: () => number;
}

export const DEFAULT_MAX_KEYS = 100_000;

export function inProcessRateLimiter({ limit, periodMs, maxKeys = DEFAULT_MAX_KEYS, now = () => Date.now() }: WindowOptions): RateLimiter {
  let windowStart = now();
  let current = new Map<string, number>();
  let previous = new Map<string, number>();

  return {
    async limit({ key }) {
      const at = now();
      const elapsed = at - windowStart;
      if (elapsed >= periodMs) {
        previous = elapsed >= periodMs * 2 ? new Map() : current;
        current = new Map();
        windowStart += Math.floor(elapsed / periodMs) * periodMs;
      }
      const carried = (previous.get(key) ?? 0) * (1 - (at - windowStart) / periodMs);
      const counted = current.get(key) ?? 0;
      if (carried + counted >= limit) return { success: false };
      if (counted === 0 && current.size >= maxKeys) return { success: false };
      current.set(key, counted + 1);
      return { success: true };
    },
  };
}
