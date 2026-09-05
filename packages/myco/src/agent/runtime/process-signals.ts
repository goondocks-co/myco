/**
 * How a process learns it is being stopped.
 *
 * The runtime that executes one run and the supervisor that starts runtimes
 * answer the same two signals, and each answers the first differently from the
 * ones after it.
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
