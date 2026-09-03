/**
 * Keeping a container alive for exactly as long as its run needs.
 *
 * A container's activity timer is reset by INCOMING REQUESTS. Compute does not
 * reset it. An agent run is compute-bound and receives no requests while it
 * works, so a container running one is stopped mid-run unless something renews
 * the timer on its behalf.
 *
 * Measured on Cloudflare Containers (#908) with `sleepAfter` identical at 90m:
 *
 *   without renewal   stops after 32 seconds
 *   with renewal      alive at 788 seconds, still working, 26 renewals
 *
 * Raising `sleepAfter` alone changes nothing: nothing resets the timer it
 * lengthens.
 *
 * The policy lives here, apart from the Container class, so the rule can be
 * tested without a deployed container. `HarnessContainer` supplies the
 * mechanism and nothing else.
 */

import { RUN_OVERRUN_MARGIN_MS } from '../../core/harness.js';

/** How much of `sleepAfter` may elapse between renewals. */
const RENEW_FRACTION = 0.25;
/** Never renew less often than this, whatever the fraction works out to. */
export const MAX_RENEW_INTERVAL_MS = 60_000;
/** Nor more often; a renewal is a Durable Object alarm and is not free. */
export const MIN_RENEW_INTERVAL_MS = 5_000;

/**
 * A run outlives its own deadline by this much before the hold is abandoned.
 *
 * The executor aborts a run at its `timeoutSeconds`, so a hold still live well
 * past that keeps a container alive for work that has stopped. The margin
 * covers the abort path itself rather than trusting two clocks to agree.
 */
export const HOLD_OVERRUN_MARGIN_MS = RUN_OVERRUN_MARGIN_MS;

export interface HoldState {
  runId: string;
  /** Wall-clock deadline past which the container is released. */
  holdUntil: number;
}

/** What the caller should do at this moment. */
export type HoldDecision =
  | { action: 'renew'; nextCheckAt: number }
  | { action: 'release'; reason: 'deadline-passed' };

/**
 * Renewal cadence for a given `sleepAfter`.
 *
 * Renewing at a fraction of the window leaves room for a missed alarm — the
 * container survives to the next attempt. Renewing at the window itself makes
 * every alarm load-bearing.
 */
export function renewIntervalMs(sleepAfterMs: number): number {
  const scaled = Math.floor(sleepAfterMs * RENEW_FRACTION);
  return Math.min(MAX_RENEW_INTERVAL_MS, Math.max(MIN_RENEW_INTERVAL_MS, scaled));
}

/** The deadline a run started now should be held to. */
export function holdDeadline(startedAt: number, timeoutSeconds: number): number {
  return startedAt + timeoutSeconds * 1000 + HOLD_OVERRUN_MARGIN_MS;
}

/**
 * Whether to renew the container's activity timer, or let it go.
 *
 * Releasing is the normal end of a run, not a failure: the container sleeps and
 * stops, which is what makes a per-run container cheap.
 */
export function decideHold(state: HoldState | null, now: number, sleepAfterMs: number): HoldDecision {
  if (state === null || now >= state.holdUntil) {
    return { action: 'release', reason: 'deadline-passed' };
  }
  const interval = renewIntervalMs(sleepAfterMs);
  // Never schedule a check past the deadline; the last one lands on it.
  return { action: 'renew', nextCheckAt: Math.min(now + interval, state.holdUntil) };
}
