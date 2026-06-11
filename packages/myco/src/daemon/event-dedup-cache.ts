/**
 * Shared live event-deduplication cache.
 *
 * One instance is constructed in daemon/main.ts and handed to BOTH the
 * /events dispatcher (`event-dispatch.ts`) and the buffer reconciler
 * (`reconciliation.ts`). The dispatcher consults it to suppress hook-side
 * retry storms; the reconciler records every event it replays so a late
 * live POST of the same physical event lands in the duplicate window and
 * is rejected instead of double-inserting. Both run on the daemon's main
 * loop — no locking needed.
 */

import { eventDedupKey, EVENT_DEDUP_WINDOW_MS } from '@myco/capture/dedup.js';

/**
 * Cap on tracked keys to bound memory. FIFO eviction via Map insertion
 * order is sufficient — duplicates arrive in sub-window bursts, so the
 * oldest entries are the least likely to still matter.
 */
export const EVENT_DEDUP_CACHE_MAX = 4096;

export class EventDedupCache {
  private readonly recentEvents = new Map<string, number>();

  constructor(
    private readonly windowMs: number = EVENT_DEDUP_WINDOW_MS,
    private readonly maxEntries: number = EVENT_DEDUP_CACHE_MAX,
  ) {}

  /**
   * True when an identical event was seen within the dedup window.
   * On a hit, refreshes the key's LRU position (keeping its ORIGINAL
   * first-seen timestamp) so a sustained retry stream stays caught.
   * On a miss, records the event as seen at `nowMs`.
   */
  isDuplicate(
    event: { type: string; session_id: string } & Record<string, unknown>,
    nowMs: number,
  ): boolean {
    const key = eventDedupKey(event);
    const lastSeenMs = this.recentEvents.get(key);
    if (lastSeenMs !== undefined && nowMs - lastSeenMs < this.windowMs) {
      this.recentEvents.delete(key);
      this.recentEvents.set(key, lastSeenMs);
      return true;
    }
    this.record(key, nowMs);
    return false;
  }

  /**
   * Mark a key as seen at `seenAtMs` without a duplicate check. The buffer
   * reconciler calls this for every event it replays, stamped with replay
   * time (not the event's buffered timestamp) so the window covers live
   * deliveries that race the replay.
   */
  record(key: string, seenAtMs: number): void {
    this.recentEvents.set(key, seenAtMs);
    if (this.recentEvents.size > this.maxEntries) {
      // FIFO eviction — Map preserves insertion order
      const oldest = this.recentEvents.keys().next().value;
      if (oldest !== undefined) this.recentEvents.delete(oldest);
    }
  }
}
