import type { RateLimiter } from '@myco-server-worker/env.js';

export interface BoundedRateLimiter extends RateLimiter {
  size(): number;
}

interface Window {
  startedAt: number;
  count: number;
}

/** Single-process fixed-window limiter with a hard key ceiling; a new key at capacity is refused. Test double for the platform rate-limit bindings. */
export function createIngestThrottle(
  limit: number, windowMs: number, maxKeys: number, now: () => number,
): BoundedRateLimiter {
  const windows = new Map<string, Window>();
  const expired = (w: Window, t: number) => t - w.startedAt >= windowMs;

  return {
    size: () => windows.size,
    async limit({ key }) {
      const t = now();
      let w = windows.get(key);
      if (w !== undefined && expired(w, t)) w = undefined;
      if (!windows.has(key) && windows.size >= maxKeys) {
        for (const [k, old] of windows) if (expired(old, t)) windows.delete(k);
        if (windows.size >= maxKeys) return { success: false };
      }
      if (w === undefined) w = { startedAt: t, count: 0 };
      w.count = Math.min(w.count + 1, limit + 1);
      windows.set(key, w);
      return { success: w.count <= limit };
    },
  };
}
