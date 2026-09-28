/**
 * Whether the machine a worker runs on has been awake long enough to take a run.
 *
 * A laptop asleep with its lid closed still wakes for a while at a time (a macOS
 * dark wake: seconds, and on 2026-09-27 up to 122 s), and a virtual machine
 * hosted on it is suspended and resumed with it. A worker that claims in one of
 * those wakes starts a harness that the machine suspends soon after: its lease
 * lapses while it sleeps, the Deployment returns the run to the queue, and the
 * next wake claims it again, on this worker or on another on the same host,
 * each time spending a harness session on work that is thrown away.
 *
 * Sleep is read off the wall clock at the waits a worker already makes: a wait
 * that ends far later than it was asked to means the process did not run in
 * between. A guest whose clock is stepped forward some time after it resumes
 * shows the sleep at a later wait rather than the first; it still shows. The
 * watch keeps no timer of its own.
 *
 * A worker claims only once its machine has stayed awake for the settle. The
 * settle adapts: a machine that sleeps again before it settled, or while it
 * drives a run, is cycling through short wakes, and each such sleep doubles the
 * settle up to a ceiling. A run that ends with its lease held, or a machine that
 * stays awake for the ceiling, returns it to the base. A worker process that has
 * just started has seen no sleep and claims at once.
 */

/** How much longer than asked a wait must last to count as the machine having slept rather than a busy moment. */
export const SUSPEND_SLACK_MS = 5_000;

/**
 * The settle a machine starts from: longer, with margin, than the longest dark
 * wake observed (122 s), so a wake of that length claims nothing, and short
 * beside the hours a machine that is actually in use stays up.
 */
export const WAKE_SETTLE_MS = 180_000;

/** The ceiling the settle doubles up to while a machine keeps sleeping in short wakes. */
export const WAKE_SETTLE_MAX_MS = 900_000;

export interface WakeSettle {
  baseMs: number;
  maxMs: number;
}

export interface WakeWatch {
  /**
   * A wait of `ms` starts now. The answer is called when it ends: it records a
   * sleep when the wall clock moved further than the wait could account for,
   * and answers whether it did.
   */
  begin(ms: number): () => boolean;
  /** How long the machine has been awake since it last slept; infinite when no sleep has been seen. */
  awakeFor(): number;
  /** How long the machine must be awake before its worker claims, as the sleeps seen so far set it. */
  settleMs(): number;
  /** Whether the machine has been awake for the settle. */
  settled(): boolean;
  /** Whether a run is being driven: a sleep while one is lengthens the settle as a sleep while settling does. */
  driving(on: boolean): void;
  /** A run ended with its lease held: the machine stayed up for a whole run, and the settle returns to its base. */
  ranThrough(): void;
}

export function watchWake(
  now: () => number = Date.now,
  settle: WakeSettle = { baseMs: WAKE_SETTLE_MS, maxMs: WAKE_SETTLE_MAX_MS },
  slackMs: number = SUSPEND_SLACK_MS,
): WakeWatch {
  let wokeAt = Number.NEGATIVE_INFINITY;
  let currentMs = settle.baseMs;
  let inRun = false;
  const awakeFor = (): number => {
    const awake = now() - wokeAt;
    if (awake >= settle.maxMs) currentMs = settle.baseMs;
    return awake;
  };
  return {
    begin(ms) {
      const from = now();
      return () => {
        const at = now();
        if (at - from <= ms + slackMs) return false;
        // Awake for less than the settle when it went to sleep, or asleep under a run: a machine in short wakes.
        if (inRun || from - wokeAt < currentMs) currentMs = Math.min(currentMs * 2, settle.maxMs);
        wokeAt = at;
        return true;
      };
    },
    awakeFor,
    settleMs: () => { awakeFor(); return currentMs; },
    settled: () => awakeFor() >= currentMs,
    driving: (on) => { inRun = on; },
    ranThrough: () => { currentMs = settle.baseMs; },
  };
}
