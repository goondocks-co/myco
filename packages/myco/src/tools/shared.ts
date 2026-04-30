/**
 * Shared helpers for MCP tool handlers.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

/**
 * Build an endpoint URL with optional query string parameters.
 * Undefined values are silently omitted. All values are stringified.
 */
export function buildEndpoint(base: string, params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, val] of Object.entries(params)) {
    if (val !== undefined) qs.set(key, String(val));
  }
  const str = qs.toString();
  return str ? `${base}?${str}` : base;
}

export async function isCollectiveEnabled(client: DaemonClient): Promise<boolean> {
  try {
    const status = await client.get('/api/team/status');
    return Boolean(status.ok && status.data?.collective_connected);
  } catch {
    return false;
  }
}
