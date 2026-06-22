import { createHash } from 'node:crypto';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;

/**
 * Derive a deterministic port from a vault path.
 *
 * The default binding port: launchers, hooks, MCP children, and the daemon
 * all derive the same value from the service path so they converge without
 * per-machine config. An optional explicit override (`daemon.port` in the
 * home's config) is layered on top in `resolveGlobalDaemonPort` — the single
 * resolver every consumer funnels through, so the override converges too and
 * never produces a daemon-binds-X-while-hooks-derive-Y mismatch. Startup
 * either binds the resolved port or fails loudly (squatter) / steps aside
 * (sibling).
 */
export function derivePort(vaultPath: string): number {
  const hash = createHash('md5').update(vaultPath).digest();
  const num = hash.readUInt16LE(0);
  return PORT_RANGE_START + (num % PORT_RANGE_SIZE);
}
