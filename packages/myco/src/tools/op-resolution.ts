/**
 * How a tool call's `op` is resolved from its arguments.
 *
 * Extracted so every gate that judges a call by its op — the external
 * read-only allowlist (`mcp/external-surface.ts`) and project write
 * admission (`tools/lease-admission.ts`) — resolves it exactly one way. A
 * second copy of these defaults would be a silent misclassification
 * waiting to happen: an admission gate that resolved an omitted `op` to a
 * different default than the real handler would judge a call it is not
 * actually about to make.
 */

/**
 * Every tool schema defaults `op` to `'list'` except `myco_cortex`
 * (`'digest'`) and `myco_agent` (`'runs'`) — the SAME defaults
 * `tools/definitions.ts` documents, so an omitted `op` is judged exactly
 * as the real handler would interpret it.
 */
const DEFAULT_OP: Record<string, string> = {
  myco_cortex: 'digest',
  myco_agent: 'runs',
};

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return {};
}

/**
 * The op a call would actually run under, applying the same per-tool
 * default the real tool schema uses when `op` is omitted.
 */
export function effectiveOp(toolName: string, args: unknown): string {
  const input = normalizeArgs(args);
  const raw = input.op;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return DEFAULT_OP[toolName] ?? 'list';
}
