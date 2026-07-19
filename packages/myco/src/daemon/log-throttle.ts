/**
 * Once-per-interval log throttle (Task 2, E-4 W2 — refusal observability).
 *
 * A handful of Team Host refusal classes are otherwise silent: the caller
 * gets a clean 404/4xx/5xx, but nothing lands in the daemon log. Once they
 * start logging, an UNTHROTTLED warn per refusal is a log storm rather than
 * observability — a member's capture-drain retry loop reissues the identical
 * refused request every daemon tick. `shouldLogOncePerInterval` is the one
 * small mechanism every such call site shares: true the first time a key is
 * seen (or once `intervalMs` has elapsed since the last true result for that
 * key), false otherwise.
 *
 * ONE module-level map backs every caller — this function does not scope
 * state per caller or per feature. Callers MUST build a fully-qualified key
 * (a stable prefix plus their own dimensions, e.g. `unknown_tenancy:...`,
 * `served_grove:...`, `relay:...`) so two unrelated call sites never
 * collide on the same literal key.
 *
 * Bounded like `EventDedupCache` (`daemon/event-dedup-cache.ts`): once the
 * map holds {@link REFUSAL_LOG_THROTTLE_MAX_KEYS} entries, the single oldest
 * (FIFO, `Map` insertion order) is evicted before a new key is recorded. An
 * actively-suppressed key (still within its throttle window) has its
 * position refreshed on every check so it survives eviction pressure from
 * unrelated keys, mirroring `EventDedupCache.isDuplicate`.
 */
import { REFUSAL_LOG_THROTTLE_MAX_KEYS } from '../constants.js';

const lastLoggedAt = new Map<string, number>();

// Every production call site omits `nowMs` and gets this default. A
// module-local indirection (rather than reading `Date.now()` inline) so an
// integration test can simulate the throttle interval elapsing by swapping
// the clock (`__setLogThrottleClockForTests`) without depending on the
// runtime's global system-time mocking, which this sandbox does not honor
// for direct `Date.now()` reads (only for scheduled-timer firing).
let clock: () => number = Date.now;

/**
 * @param key fully-qualified, caller-namespaced throttle key.
 * @param intervalMs the throttle window.
 * @param nowMs injectable clock (tests only); defaults to the module clock
 *   (`Date.now` in production).
 */
export function shouldLogOncePerInterval(key: string, intervalMs: number, nowMs: number = clock()): boolean {
  const last = lastLoggedAt.get(key);
  if (last !== undefined && nowMs - last < intervalMs) {
    // Still within the throttle window: refresh this key's recency so a hot,
    // repeatedly-refused key survives eviction pressure from unrelated keys.
    lastLoggedAt.delete(key);
    lastLoggedAt.set(key, last);
    return false;
  }
  lastLoggedAt.delete(key);
  if (lastLoggedAt.size >= REFUSAL_LOG_THROTTLE_MAX_KEYS) {
    const oldest = lastLoggedAt.keys().next().value;
    if (oldest !== undefined) lastLoggedAt.delete(oldest);
  }
  lastLoggedAt.set(key, nowMs);
  return true;
}

/** Test seam only: override the clock every call site defaults to when it
 *  doesn't pass an explicit `nowMs` (production never does). */
export function __setLogThrottleClockForTests(fn: () => number): void {
  clock = fn;
}

/** Test seam only: reset all throttle state AND the clock override between
 *  tests. */
export function __resetLogThrottleForTests(): void {
  lastLoggedAt.clear();
  clock = Date.now;
}

/** Test seam only: current tracked-key count (map-bound assertions). */
export function __logThrottleSizeForTests(): number {
  return lastLoggedAt.size;
}
