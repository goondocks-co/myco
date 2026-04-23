import { createHash } from 'node:crypto';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;

/**
 * Derive a deterministic port from a vault path.
 *
 * The port is the authoritative binding target for a daemon — either this
 * derived value, or an explicit override in `myco.yaml` under `daemon.port`.
 * Startup never silently falls back to a different port; if the canonical
 * port is unavailable, the daemon either steps aside (sibling wins) or
 * fails loudly (unrelated squatter).
 */
export function derivePort(vaultPath: string): number {
  const hash = createHash('md5').update(vaultPath).digest();
  const num = hash.readUInt16LE(0);
  return PORT_RANGE_START + (num % PORT_RANGE_SIZE);
}
