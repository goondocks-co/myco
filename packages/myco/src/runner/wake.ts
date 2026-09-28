/**
 * Whether the machine a worker runs on has been awake long enough to take a run.
 *
 * A laptop asleep with its lid closed still wakes for a few seconds at a time
 * (a macOS dark wake), and a virtual machine hosted on it is suspended and
 * resumed with it. A worker that claims in one of those wakes starts a harness
 * that the machine suspends moments later: its lease lapses while it sleeps, the
 * Deployment returns the run to the queue, and the next wake claims it again,
 * on this worker or on another on the same host, each time spending a harness
 * session on work that is thrown away.
 *
 * Sleep is read off the wall clock the Deployment writes leases in, at the waits
 * a worker already makes: a wait that ends far later than it was asked to means
 * the process did not run in between. The watch keeps no timer of its own. It
 * records the instant the machine came back, which is all a worker needs to
 * decide two things: whether it has been awake long enough to claim, and
 * whether a lease it held outlived the sleep.
 */

/** How much longer than asked a wait must last to count as the machine having slept rather than a busy moment. */
export const SUSPEND_SLACK_MS = 5_000;

/**
 * How long a machine must have been awake, since it last slept, before its
 * worker claims. Longer than the seconds a dark wake lasts; short beside the
 * minutes a run takes.
 */
export const WAKE_SETTLE_MS = 60_000;

export interface WakeWatch {
  /**
   * A wait of `ms` starts now. The answer is called when it ends: it records a
   * sleep when the wall clock moved further than the wait could account for,
   * and answers whether it did.
   */
  begin(ms: number): () => boolean;
  /** How long the machine has been awake since it last slept; infinite when no sleep has been seen. */
  awakeFor(): number;
}

/** Watch for sleep on `now`. The process start is not a wake: a worker started on a machine that is up claims at once. */
export function watchWake(now: () => number = Date.now, slackMs: number = SUSPEND_SLACK_MS): WakeWatch {
  let wokeAt = Number.NEGATIVE_INFINITY;
  return {
    begin(ms) {
      const from = now();
      return () => {
        const at = now();
        if (at - from <= ms + slackMs) return false;
        wokeAt = at;
        return true;
      };
    },
    awakeFor: () => now() - wokeAt,
  };
}
