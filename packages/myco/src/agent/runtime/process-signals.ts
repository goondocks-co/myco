/**
 * How a process learns it is being stopped.
 *
 * Both the runtime that executes one run and the supervisor that starts
 * runtimes answer the same two signals, so the names and the shape they are
 * listened for on are held once here.
 */

/** The signals a platform sends a process it is draining. */
export const RUNTIME_STOP_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/** Where a process's own deaths and stop signals are announced. */
export interface ProcessEvents {
  on(event: string, listener: (reason?: unknown) => void): unknown;
}
