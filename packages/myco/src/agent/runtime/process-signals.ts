/**
 * How a runtime process is stopped, and how it says what it did.
 *
 * The runtime that executes one run and the supervisor that starts runtimes
 * answer the same two signals, and each answers the first differently from the
 * ones after it. The exit codes are the other half of that conversation: the
 * supervisor reads them to decide whether a run still owes the Deployment an
 * ending, so both sides name them here.
 */

/** The signals a platform sends a process it is draining. */
export const RUNTIME_STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Where a process's own deaths and stop signals are announced. */
export interface ProcessEvents {
  on(event: string, listener: (reason?: unknown) => void): unknown;
}

/**
 * Answer every stop signal, told which one this is.
 *
 * A platform sends SIGTERM, then SIGINT, and sends SIGTERM again when the first
 * is not answered. Ordinal 1 is the drain; anything above it is an operator who
 * is done waiting.
 */
export function onStopSignals(events: ProcessEvents, handle: (ordinal: number) => void): void {
  let seen = 0;
  for (const signal of RUNTIME_STOP_SIGNALS) {
    events.on(signal, () => { seen += 1; handle(seen); });
  }
}

/**
 * What a runtime's exit code says about the run it held.
 *
 * Only these two mean the row already carries an ending. Everything else — a
 * kill, an out-of-memory, a signal, a bundle that would not start, a throw
 * before the run's own handlers are live — is a death the runtime did not get
 * to describe, and the supervisor closes the run in its place. `1` is left out
 * deliberately: it is what a runtime that never started answers, so a runtime
 * saying `1` is saying nothing.
 */
export const RUNTIME_EXIT = {
  /** The run finished and this process posted its ending. */
  ran: 0,
  /** This process named the run's failure on the row itself. */
  named: 2,
  /** This process ended with a failure it could not post. */
  unposted: 3,
} as const;

/** The exit codes that mean the run's row already carries an ending. */
export const RUNTIME_OWN_ENDINGS: ReadonlySet<number> = new Set<number>([RUNTIME_EXIT.ran, RUNTIME_EXIT.named]);
