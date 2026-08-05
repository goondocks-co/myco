/**
 * Failed-auth throttle for the team listener.
 *
 * Neither listener had one. That was defensible behind a tailnet, where the
 * listener's own docstring said token entropy was the entire defence — and it
 * is thin on a URL anyone can reach. 256 bits is not brute-forcible, but "not
 * brute-forcible" is a statement about the token, not about what an unbounded
 * stream of failed attempts costs the host: every one reaches disk (the member
 * store is re-read per request, deliberately) and every one is a syscall the
 * host performs for a caller who has proven nothing.
 *
 * WHAT THIS IS NOT. There is no per-source dimension, because there is no
 * source to key on: the listener answers a unix socket and every request
 * arrives from the local Funnel process, so a remote address would be a
 * constant. The throttle is therefore GLOBAL over failures, and the tradeoff is
 * explicit — a hostile caller can slow down a legitimate member's first attempt
 * after a token change. That is acceptable in a way it would not be for a login
 * form: members are daemons that retry, the delay is bounded and short, and
 * SUCCESS RESETS IT, so the steady state for a working team is no delay at all.
 *
 * Delay rather than refusal, for the same reason: refusing outright would let a
 * scanner lock a team out of its own host.
 */

/** Consecutive failures below this are free — a member with a stale token
 *  retrying a couple of times should not be punished. */
const FREE_FAILURES = 5;

/** Delay added per failure past the free allowance. */
const BACKOFF_STEP_MS = 250;

/** Ceiling on the delay. Bounded because this is a speed bump, not a lockout:
 *  an unbounded backoff is a denial-of-service an anonymous caller can inflict
 *  on the team. */
const MAX_BACKOFF_MS = 2_000;

/** Failures stop counting after this long without one, so a host that saw a
 *  burst last week does not start throttled today. */
const FAILURE_WINDOW_MS = 60_000;

export interface AuthThrottle {
  /** How long to wait before answering the current failed attempt. */
  delayForFailure(): number;
  /** Record a failed authentication and return the delay to apply. */
  noteFailure(): number;
  /** Record a success — clears the streak. */
  noteSuccess(): void;
  /** Test seam. */
  reset(): void;
}

export function createAuthThrottle(now: () => number = Date.now): AuthThrottle {
  let consecutive = 0;
  let lastFailureAt = 0;

  const currentStreak = (): number => {
    if (consecutive > 0 && now() - lastFailureAt > FAILURE_WINDOW_MS) consecutive = 0;
    return consecutive;
  };

  const delayFor = (streak: number): number =>
    Math.min(MAX_BACKOFF_MS, Math.max(0, streak - FREE_FAILURES) * BACKOFF_STEP_MS);

  return {
    delayForFailure: () => delayFor(currentStreak()),
    noteFailure() {
      const streak = currentStreak() + 1;
      consecutive = streak;
      lastFailureAt = now();
      return delayFor(streak);
    },
    noteSuccess() {
      consecutive = 0;
    },
    reset() {
      consecutive = 0;
      lastFailureAt = 0;
    },
  };
}

/** Sleep helper for the listener's refusal path. Separate so a test can assert
 *  the DELAY the throttle chose without waiting it out. */
export function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => { setTimeout(resolve, ms); });
}
