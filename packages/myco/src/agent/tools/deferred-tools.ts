/**
 * Deferred tool-schema loading.
 *
 * Two pure helpers used by `createVaultTools()` (tools.ts):
 *   - `applyDeferredStubs` replaces a deferrable tool's description/schema
 *     with a lightweight stub in the surface handed to the harness/model.
 *     The handler reference is never touched — deferred loading is a
 *     prompt-context optimization, not an access-control gate. A model
 *     that calls a deferred tool directly (without calling
 *     vault_search_tools first) still succeeds.
 *   - `buildSearchToolsTool` synthesizes the `vault_search_tools` meta-tool
 *     from the current (pre-stub) tool list. Returns null when no tool is
 *     deferrable, so the meta-tool never appears in a phase that doesn't
 *     need it.
 *
 * See docs/superpowers/specs/2026-07-01-tool-discovery-at-scale-design.md.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { textResult, type MycoToolDefinition } from './types.js';

/** Placeholder description shown for a deferred tool's stub. */
export const DEFERRED_STUB_DESCRIPTION =
  '(deferred — call vault_search_tools to load the full description and schema for this tool. '
  + 'You do not need to wait for that call: arguments sent directly to this tool still reach the real handler unchanged.)';

/**
 * Stub input schema applied to every deferrable tool. MUST be a full Zod
 * object schema (not a raw shape) — the SDK's MCP registration (see
 * `ls()` in the vendored `@anthropic-ai/claude-agent-sdk`) special-cases
 * objects that are already Zod schemas and passes them through untouched
 * for both the advertised JSON Schema and argument validation. A raw
 * `{}` shape instead gets treated as "zero declared properties", which
 * the SDK's MCP dispatch validates arguments against — silently
 * stripping every argument the model sends, even after the model has
 * discovered the tool's real schema via `vault_search_tools` (each
 * phase registers tool schemas once; there is no re-registration
 * mid-phase). `.passthrough()` keeps the schema genuinely permissive —
 * any shape of args parses successfully and reaches the real handler.
 */
const DEFERRED_STUB_SCHEMA = z.object({}).passthrough();

/**
 * Replace description/inputSchema on every deferrable tool with a stub.
 * Non-deferrable tools are returned by reference, unchanged.
 */
export function applyDeferredStubs(tools: MycoToolDefinition[]): MycoToolDefinition[] {
  return tools.map((t) => {
    if (t.deferrable !== true) return t;
    return {
      ...t,
      description: DEFERRED_STUB_DESCRIPTION,
      inputSchema: DEFERRED_STUB_SCHEMA,
    };
  });
}

/**
 * Returns true when `value` is itself a Zod schema instance (as opposed to
 * a raw `{ key: ZodType }` shape object). Mirrors the discriminator the
 * vendored SDK's own schema normalizer uses (`'_zod' in value`) — see
 * `normalizeInputSchema` in `agent/harness/openai-local-mcp.ts`, which
 * needs the identical distinction for the same reason.
 */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

/**
 * Convert a tool's `inputSchema` (either a raw `{ key: ZodType }` shape —
 * what every hand-authored `tool(...)` call in this codebase produces —
 * or a full Zod object schema, as `applyDeferredStubs`'s stub now uses)
 * into a real JSON Schema document, preserving `.describe()` metadata.
 *
 * `JSON.stringify`-ing a raw zod shape directly (the previous behavior)
 * serializes zod v4's internal `_zod`/`def` fields instead of a JSON
 * Schema — and critically drops every `.describe()` call, because zod v4
 * keeps description metadata in a side registry keyed by schema
 * identity, not on the schema's own serializable `def`. `z.toJSONSchema`
 * is the only conversion path that consults that registry.
 *
 * Non-object, non-shape inputs (e.g. a plain `{}` placeholder used by
 * tests, or an absent schema) fall back to an empty object schema rather
 * than throwing — `vault_search_tools` is a best-effort discovery aid,
 * not a strict contract validator.
 */
function toDiscoverySchema(inputSchema: unknown): Record<string, unknown> {
  try {
    if (isZodSchema(inputSchema)) {
      return z.toJSONSchema(inputSchema) as Record<string, unknown>;
    }
    if (inputSchema && typeof inputSchema === 'object') {
      const entries = Object.values(inputSchema as Record<string, unknown>);
      if (entries.length > 0 && entries.every(isZodSchema)) {
        return z.toJSONSchema(z.object(inputSchema as Record<string, z.ZodTypeAny>)) as Record<string, unknown>;
      }
    }
  } catch {
    /* fall through to the empty-schema default below */
  }
  return { type: 'object', properties: {} };
}

/**
 * Build the `vault_search_tools` meta-tool from the CURRENT (pre-stub)
 * tool list. Returns null when no tool is deferrable — callers should
 * only append the result to the tool surface when it is non-null.
 */
export function buildSearchToolsTool(tools: MycoToolDefinition[]): MycoToolDefinition | null {
  const deferred = tools.filter((t) => t.deferrable === true);
  if (deferred.length === 0) return null;

  return tool(
    'vault_search_tools',
    'Search for tools whose full schema was deferred from this phase\'s initial tool list to save context. ' +
    'Pass a keyword describing what you need to do; matching tools are returned with their full description ' +
    'and a real JSON Schema (including field descriptions) so you can call them directly by name afterward. ' +
    'Deferred tools are still callable without calling this first if you already know their shape — this is a ' +
    'discovery aid, not a gate.',
    {
      query: z.string().min(1).describe('Keyword or short phrase describing the capability you need (matched against deferred tool names and summaries).'),
    },
    async (args) => {
      const q = args.query.toLowerCase();
      const matches = deferred.filter((t) =>
        t.name.toLowerCase().includes(q) || (t.searchSummary ?? '').toLowerCase().includes(q));
      return textResult(matches.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: toDiscoverySchema(t.inputSchema),
      })));
    },
    { annotations: { readOnlyHint: true } },
  ) as unknown as MycoToolDefinition;
}
