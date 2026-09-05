/**
 * Which port a runtime serves its own probe on.
 *
 * The container port is what the platform's probe and hold talk to. A runtime
 * sharing one network namespace with its siblings serves no listener, and its
 * launch spells that with a word rather than a number: zero is an ephemeral
 * port in Bun.
 */

/** The port a runtime serves when its launch names none. */
export const RUNTIME_PROBE_PORT = 8080;

/** What `MYCO_RUNTIME_PORT` is set to for a runtime that serves no listener at all. */
export const NO_RUNTIME_LISTENER = 'none';

/** The highest port a listener can bind. */
const MAX_PORT = 65_535;

/** A port, in decimal, and nothing else: `0x1f` and `1e3` are not ports. */
const DECIMAL_PORT = /^\d{1,5}$/;

/** The port a runtime should serve on, or `null` for no listener. A value that is neither is refused rather than taken as the default. */
export function runtimePortFrom(value: string | undefined): number | null {
  if (value === undefined || value === '') return RUNTIME_PROBE_PORT;
  if (value === NO_RUNTIME_LISTENER) return null;
  const parsed = DECIMAL_PORT.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed > MAX_PORT) {
    throw new Error(`MYCO_RUNTIME_PORT must be a port or ${JSON.stringify(NO_RUNTIME_LISTENER)}, and is ${JSON.stringify(value)}`);
  }
  return parsed;
}
