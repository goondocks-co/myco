/**
 * `shouldLogOncePerInterval` (Task 2, E-4 W2) — the shared once-per-interval
 * throttle every refusal-observability log site (`daemon/server.ts`,
 * `mcp/http.ts`, `daemon/host-proxy.ts`) is built on.
 *
 * Pure unit coverage: no daemon, no HTTP. Integration coverage of each real
 * call site lives in `tests/daemon/host-transport-gate.test.ts`,
 * `tests/daemon/host-serve-grove-filter.test.ts`, and
 * `tests/daemon/host-proxy.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  shouldLogOncePerInterval,
  __resetLogThrottleForTests,
  __logThrottleSizeForTests,
} from '@myco/daemon/log-throttle';
import { REFUSAL_LOG_THROTTLE_MAX_KEYS } from '@myco/constants';

describe('shouldLogOncePerInterval', () => {
  afterEach(() => {
    __resetLogThrottleForTests();
  });

  test('first sighting of a key logs', () => {
    expect(shouldLogOncePerInterval('k1', 1000, 0)).toBe(true);
  });

  test('a repeat within the interval is throttled (silent)', () => {
    expect(shouldLogOncePerInterval('k1', 1000, 0)).toBe(true);
    expect(shouldLogOncePerInterval('k1', 1000, 500)).toBe(false);
    expect(shouldLogOncePerInterval('k1', 1000, 999)).toBe(false);
  });

  test('once the interval fully elapses, the key logs again', () => {
    expect(shouldLogOncePerInterval('k1', 1000, 0)).toBe(true);
    expect(shouldLogOncePerInterval('k1', 1000, 1000)).toBe(true);
  });

  test('distinct keys never throttle each other', () => {
    expect(shouldLogOncePerInterval('k1', 1000, 0)).toBe(true);
    expect(shouldLogOncePerInterval('k2', 1000, 0)).toBe(true);
    expect(shouldLogOncePerInterval('k2', 1000, 1)).toBe(false);
  });

  test('nowMs defaults to Date.now() when omitted', () => {
    // No injected clock: this just proves the call succeeds and returns a
    // boolean without throwing — production call sites rely on this default.
    expect(typeof shouldLogOncePerInterval('k-default-clock', 1000)).toBe('boolean');
  });

  test('map stays bounded: inserting past the cap evicts the oldest entry', () => {
    for (let i = 0; i < REFUSAL_LOG_THROTTLE_MAX_KEYS; i++) {
      expect(shouldLogOncePerInterval(`bound-${i}`, 60_000, i)).toBe(true);
    }
    expect(__logThrottleSizeForTests()).toBe(REFUSAL_LOG_THROTTLE_MAX_KEYS);

    // One more distinct key pushes the map past the cap; the FIRST-inserted
    // key ("bound-0") must have been evicted, so re-checking it (well within
    // what would otherwise still be its throttle window) reports "first
    // sighting" again rather than staying throttled.
    expect(shouldLogOncePerInterval(`bound-${REFUSAL_LOG_THROTTLE_MAX_KEYS}`, 60_000, REFUSAL_LOG_THROTTLE_MAX_KEYS)).toBe(true);
    expect(__logThrottleSizeForTests()).toBe(REFUSAL_LOG_THROTTLE_MAX_KEYS);
    expect(shouldLogOncePerInterval('bound-0', 60_000, REFUSAL_LOG_THROTTLE_MAX_KEYS + 1)).toBe(true);
  });

  test('a hot key refreshed inside its window survives eviction pressure from unrelated keys', () => {
    expect(shouldLogOncePerInterval('hot', 60_000, 0)).toBe(true);
    // Flood the map with (cap - 1) other distinct keys — leaves exactly one
    // eviction slot of headroom before "hot" would be at risk.
    for (let i = 0; i < REFUSAL_LOG_THROTTLE_MAX_KEYS - 1; i++) {
      shouldLogOncePerInterval(`flood-${i}`, 60_000, 1);
      // Touch "hot" again every iteration (still well inside its window) so
      // its recency keeps refreshing instead of aging toward eviction.
      shouldLogOncePerInterval('hot', 60_000, 1);
    }
    // "hot" must still be tracked (still throttled, not a fresh "first
    // sighting") — proof its position was kept warm rather than evicted.
    expect(shouldLogOncePerInterval('hot', 60_000, 2)).toBe(false);
  });

  test('__resetLogThrottleForTests clears all state', () => {
    shouldLogOncePerInterval('k1', 1000, 0);
    expect(__logThrottleSizeForTests()).toBeGreaterThan(0);
    __resetLogThrottleForTests();
    expect(__logThrottleSizeForTests()).toBe(0);
    expect(shouldLogOncePerInterval('k1', 1000, 0)).toBe(true);
  });
});
