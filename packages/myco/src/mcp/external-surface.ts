/**
 * The external read-only MCP surface (server-mode design spec §7).
 *
 * Non-member agents (Managed Agents, N8N, Copilot) that never join the
 * tailnet reach a Team Host's Grove through this surface over public HTTPS
 * (Tailscale Funnel). The daemon's own `/mcp` is NOT read-only — `myco_plans`/
 * `myco_spores` expose editorial writes and nothing filters by `readOnlyHint`
 * (spec §7's grounded correction) — so this is an explicit per-(tool, op)
 * ALLOWLIST, never a tool-name filter, never a `readOnlyHint` denylist. It
 * mirrors the worker's proven contract (`myco-team/worker/src/mcp/server.ts`).
 *
 * Fails closed: a (tool, op) pair not listed here does not exist on this
 * surface. `createExternalTools` wraps a real `MycoTools` instance so the
 * external listener (`daemon/external-listener.ts`) dispatches through the
 * SAME handlers every local caller uses — this module only narrows what is
 * reachable, never re-implements a tool.
 */
import { ToolError } from '../tools/error.js';
import type { MycoTools } from '../tools/index.js';
import type { ToolDefinition } from '../tools/definitions.js';

/** The ONLY (tool, op) pairs that exist on the external surface. Fails closed:
 *  anything not listed here does not exist externally. Mirrors the worker's
 *  proven contract (worker/src/mcp/server.ts:22-87). */
export const EXTERNAL_TOOL_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  myco_search:   new Set(['*']),            // query-only tool
  myco_cortex:   new Set(['digest']),       // NEVER maintenance_summary/projects_activity
  myco_plans:    new Set(['list', 'get']),
  myco_sessions: new Set(['list', 'get']),
  myco_skills:   new Set(['list', 'get']),
  myco_spores:   new Set(['list', 'get']),
};

/** Every tool schema below defaults `op` to `'list'` except `myco_cortex`
 *  (defaults to `'digest'`) — the SAME defaults `tools/definitions.ts`
 *  documents, so an omitted `op` is judged exactly as the real handler would
 *  interpret it. */
const DEFAULT_OP: Record<string, string> = {
  myco_cortex: 'digest',
};

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args as Record<string, unknown>;
  return {};
}

/** Extracts the effective op a call would run under, applying the same
 *  per-tool default the real tool schema uses when `op` is omitted. */
function effectiveOp(toolName: string, args: unknown): string {
  const input = normalizeArgs(args);
  const raw = input.op;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return DEFAULT_OP[toolName] ?? 'list';
}

/** True when `(toolName, op resolved from args)` is on the external
 *  allowlist. `myco_search` has no `op` concept — its wildcard entry admits
 *  the tool unconditionally. */
export function isAllowedExternalCall(toolName: string, args: unknown): boolean {
  const allowedOps = EXTERNAL_TOOL_ALLOWLIST[toolName];
  if (!allowedOps) return false;
  if (allowedOps.has('*')) return true;
  return allowedOps.has(effectiveOp(toolName, args));
}

/** The `unknown_tool`-shaped refusal for anything the allowlist excludes —
 *  byte-identical to what a genuinely nonexistent tool name produces, so a
 *  probing caller cannot distinguish "not on this surface" from "does not
 *  exist" (spec §7: fails closed). */
function unknownToolRefusal(toolName: string): ToolError {
  return new ToolError('unknown_tool', `Unknown tool: ${toolName}`);
}

/**
 * Wrap a real `MycoTools` instance (the SAME shared runtime every local/
 * overlay caller dispatches through) so only allowlisted (tool, op) pairs
 * are reachable. `listTools()` narrows the advertised catalog to the
 * allowlisted tool NAMES (an external client should never even see
 * `myco_agent` or the write-capable ops exist); `callTool()` is the actual
 * enforcement point — every dispatch re-checks the allowlist immediately
 * before delegating, so narrowing `listTools()` is defense in depth, not
 * the boundary itself.
 */
export function createExternalTools(tools: MycoTools): MycoTools {
  const allowedNames = new Set(Object.keys(EXTERNAL_TOOL_ALLOWLIST));

  return {
    async listTools(): Promise<ToolDefinition[]> {
      const all = await tools.listTools();
      return all.filter((tool) => allowedNames.has(tool.name));
    },

    getRegisteredTools(): string[] {
      return [...allowedNames];
    },

    async callTool(name: string, args?: unknown): Promise<unknown> {
      if (!isAllowedExternalCall(name, args)) {
        throw unknownToolRefusal(name);
      }
      return tools.callTool(name, args);
    },
  };
}
