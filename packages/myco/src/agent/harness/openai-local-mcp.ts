import type { MCPServer } from '@openai/agents';
import { z } from 'zod/v4';
import type { ZodRawShape } from 'zod';
import { createVaultTools } from '@myco/agent/tools.js';
import type { HarnessToolSurface } from './types.js';

interface LocalMcpTool {
  name: string;
  description?: string;
  /**
   * Either a raw `{ key: ZodType }` shape (every hand-authored `tool(...)`
   * call in this codebase) or a full Zod object schema — the deferred-tool
   * stub in `agent/tools/deferred-tools.ts` uses `z.object({}).passthrough()`
   * so arbitrary args reach the real handler. See `normalizeInputSchema`.
   */
  inputSchema?: ZodRawShape | z.ZodTypeAny;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

/** True when `value` is itself a Zod schema instance, not a raw shape. */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

class LocalVaultMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  private readonly tools: LocalMcpTool[];
  readonly name = 'myco-vault';

  constructor(toolSurface: HarnessToolSurface) {
    // Map-phase fast path: when the caller has pre-materialized the tool
    // list (e.g. with argMap-stripped sink schemas and outcome-capture
    // wrappers), use those directly instead of rebuilding from scratch.
    // Rebuilding via createVaultTools() would discard those modifications
    // — see executeMapPhase in agent/map-phase.ts and the design spec
    // (docs/superpowers/specs/2026-04-28-map-phase-mode-design.md, "Why
    // this shape") for why the materialized tools must flow through.
    if (toolSurface.tools && toolSurface.tools.length > 0) {
      this.tools = toolSurface.tools as unknown as LocalMcpTool[];
      return;
    }

    const nameSet = toolSurface.toolNames ? new Set(toolSurface.toolNames) : null;
    const allTools = createVaultTools(toolSurface.agentId, toolSurface.runId, {
      onlyNames: toolSurface.toolNames ? new Set(toolSurface.toolNames) : undefined,
      turnOffset: toolSurface.turnOffset,
      projectRoot: toolSurface.projectRoot,
      vaultDir: toolSurface.vaultDir,
      requestContext: toolSurface.requestContext,
      embeddingManager: toolSurface.embeddingManager,
      dryRun: toolSurface.dryRun,
      metadataAccumulator: toolSurface.metadataAccumulator,
      phasePurpose: toolSurface.phasePurpose,
      semanticCheckEnabled: toolSurface.semanticCheckEnabled,
      harnessId: toolSurface.harnessId,
      model: toolSurface.model,
      classifierReasoningLevel: toolSurface.classifierReasoningLevel,
      provider: toolSurface.provider,
      flaggedWritesAccumulator: toolSurface.flaggedWritesAccumulator,
      hooks: toolSurface.hooks,
      hookContext: toolSurface.hookContext,
      deferredNames: toolSurface.deferredNames ? new Set(toolSurface.deferredNames) : undefined,
      logger: toolSurface.logger,
    }).filter((tool) => !toolSurface.readOnly || tool.annotations?.readOnlyHint === true);
    // vault_search_tools is synthesized by createVaultTools when any tool
    // in scope is deferrable and is never itself in `toolNames` — let it
    // through the name-scoping filter explicitly, same as
    // createScopedVaultToolServer's Claude-harness counterpart.
    this.tools = (nameSet
      ? allTools.filter((tool) => nameSet.has(tool.name) || tool.name === 'vault_search_tools')
      : allTools) as LocalMcpTool[];
  }

  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  async invalidateToolsCache(): Promise<void> {}

  async listTools() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown> | null, _meta?: Record<string, unknown> | null) {
    const tool = this.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Unknown MCP tool: ${toolName}`);
    }
    const result = await tool.handler(args ?? {});
    // Vault tools invoke synchronous bun:sqlite work — a chatty agent doing
    // dozens of tool calls per turn would queue all of them as immediate
    // microtask resolutions, starving libuv timers (PowerManager tick) and
    // the daemon HTTP poll phase. Hand control back to libuv between tool
    // dispatches so `/health` and scheduled jobs keep getting scheduling
    // slots even during a hot tool-call burst.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return result.content;
  }

  async listResources() {
    return { resources: [] };
  }

  async listResourceTemplates() {
    return { resourceTemplates: [] };
  }

  async readResource() {
    return { contents: [] };
  }
}

function normalizeInputSchema(schema: ZodRawShape | z.ZodTypeAny | undefined) {
  if (!schema) {
    return {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  // A full Zod schema (e.g. the deferred-tool stub's `z.object({}).passthrough()`)
  // is passed straight to z.toJSONSchema — do NOT re-wrap it in z.object(),
  // which would fail on a non-shape input. `additionalProperties` on a
  // passthrough schema serializes as `{}` (an empty permissive schema, not
  // the literal `true`) — normalize any non-`false` value to `true` so a
  // deliberately permissive stub schema doesn't get read back as closed.
  const jsonSchema = isZodSchema(schema)
    ? z.toJSONSchema(schema)
    : z.toJSONSchema(z.object(schema as Record<string, z.ZodTypeAny>));
  return {
    type: 'object' as const,
    properties: (jsonSchema.properties as Record<string, unknown> | undefined) ?? {},
    required: Array.isArray(jsonSchema.required) ? jsonSchema.required : [],
    additionalProperties: jsonSchema.additionalProperties !== undefined && jsonSchema.additionalProperties !== false,
  };
}

export function createLocalVaultMcpServer(toolSurface: HarnessToolSurface): MCPServer {
  return new LocalVaultMcpServer(toolSurface);
}
