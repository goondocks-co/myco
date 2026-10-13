import { createHash } from 'node:crypto';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;

/**
 * Derive a deterministic port from a vault/service path.
 *
 * The default binding port. `resolveGlobalDaemonPort` applies the optional
 * `daemon.port` override over this. Startup binds the resolved port or fails
 * loudly (squatter) / steps aside (sibling).
 */
export function derivePort(vaultPath: string): number {
  const hash = createHash('md5').update(vaultPath).digest();
  const num = hash.readUInt16LE(0);
  return PORT_RANGE_START + (num % PORT_RANGE_SIZE);
}
