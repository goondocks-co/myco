import type { MCPServer } from '@openai/agents';
import { z } from 'zod/v4';
import type { ZodRawShape } from 'zod';
import { createVaultTools } from '@myco/agent/tools.js';
import type { HarnessToolSurface } from './types.js';

interface LocalMcpTool {
  name: string;
  description?: string;
  inputSchema?: ZodRawShape;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
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
      hooks: toolSurface.hooks,
      hookContext: toolSurface.hookContext,
    }).filter((tool) => !toolSurface.readOnly || tool.annotations?.readOnlyHint === true);
    this.tools = (nameSet
      ? allTools.filter((tool) => nameSet.has(tool.name))
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

function normalizeInputSchema(schema: ZodRawShape | undefined) {
  if (!schema) {
    return {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  const jsonSchema = z.toJSONSchema(z.object(schema as Record<string, z.ZodTypeAny>));
  return {
    type: 'object' as const,
    properties: (jsonSchema.properties as Record<string, unknown> | undefined) ?? {},
    required: Array.isArray(jsonSchema.required) ? jsonSchema.required : [],
    additionalProperties: jsonSchema.additionalProperties === true,
  };
}

export function createLocalVaultMcpServer(toolSurface: HarnessToolSurface): MCPServer {
  return new LocalVaultMcpServer(toolSurface);
}
