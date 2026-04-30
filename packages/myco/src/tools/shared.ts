/**
 * Shared helpers for MCP tool handlers.
 */

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
