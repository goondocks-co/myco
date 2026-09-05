/**
 * Which port a runtime serves its own probe on.
 *
 * The Cloudflare container's probe-and-hold contract talks to the runtime on
 * the container port, so a runtime told nothing serves it. A runtime started by
 * the self-hosted supervisor shares one network namespace with its siblings and
 * with the server, where a fixed port is a collision rather than an address, so
 * that launch spells the absence of a listener explicitly. Zero is an ephemeral
 * port in Bun and therefore cannot be that spelling.
 */

/** The port a runtime serves when its launch names none: the container port the platform probes. */
export const RUNTIME_PROBE_PORT = 8080;

/** What `MYCO_RUNTIME_PORT` is set to for a runtime that serves no listener at all. */
export const NO_RUNTIME_LISTENER = 'none';

/** The highest port a listener can bind. */
const MAX_PORT = 65_535;

/**
 * The port a runtime should serve on, or `null` for no listener.
 *
 * A value that is neither the no-listener word nor a port is refused rather
 * than taken as the default: a dispatch that meant to place the runtime
 * somewhere and named it wrongly would otherwise bind the container port and
 * collide with whatever already holds it.
 */
export function runtimePortFrom(value: string | undefined): number | null {
  if (value === undefined || value === '') return RUNTIME_PROBE_PORT;
  if (value === NO_RUNTIME_LISTENER) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) {
    throw new Error(`MYCO_RUNTIME_PORT must be a port or ${JSON.stringify(NO_RUNTIME_LISTENER)}, and is ${JSON.stringify(value)}`);
  }
  return parsed;
}
