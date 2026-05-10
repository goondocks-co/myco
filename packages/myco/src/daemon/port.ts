import { createHash } from 'node:crypto';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;

/**
 * Derive a deterministic port from a vault path.
 *
 * The single authoritative source of truth for the daemon's binding port.
 * No config override; no fallback. Launchers, hooks, MCP children, and the
 * daemon itself all derive the same value from the service path so they
 * converge without per-machine config lookup. Startup either binds the
 * canonical port or fails loudly (squatter) / steps aside (sibling).
 */
export function derivePort(vaultPath: string): number {
  const hash = createHash('md5').update(vaultPath).digest();
  const num = hash.readUInt16LE(0);
  return PORT_RANGE_START + (num % PORT_RANGE_SIZE);
}
