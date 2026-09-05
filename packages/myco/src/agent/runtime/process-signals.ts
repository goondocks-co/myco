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
 * A code the runtime chose says three things: whether it claimed the run,
 * whether the row now carries an ending, and — where it never claimed — which
 * of the reasons it was. Only `ran` and `named` mean the row carries an ending.
 * Every other code, including the `1` a process that failed to start answers
 * and any signal, leaves a run for the supervisor to close; the reason decides
 * what it writes and whether a successor is queued.
 */
export const RUNTIME_EXIT = {
  /** The run finished and the Deployment applied the ending this process posted. */
  ran: 0,
  /** This process named the run's failure on the row itself. */
  named: 2,
  /** This process held the run and ended with a failure it could not post. */
  unposted: 3,
  /** A stop signal reached this process before it could claim: the run is one a deployment took back. */
  unclaimed: 4,
  /** The dispatch named a task this runtime does not have. */
  unknownTask: 5,
  /** The Deployment refused the claim on its own terms: the Project is not admitted, or it has no provider. */
  claimRefused: 6,
  /** The run belongs to another attempt: its row names a credential this process does not hold, or another runtime holds it. */
  claimContended: 7,
} as const;

/** The exit codes that mean the run's row already carries an ending. */
export const RUNTIME_OWN_ENDINGS: ReadonlySet<number> = new Set<number>([RUNTIME_EXIT.ran, RUNTIME_EXIT.named]);
