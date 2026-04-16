import type { MCPServer } from '@openai/agents';
import { z } from 'zod/v4';
import { createVaultTools } from '@myco/agent/tools.js';
import type { RuntimeToolSurface } from './types.js';

interface LocalMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler: (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

class LocalVaultMcpServer implements MCPServer {
  readonly cacheToolsList = true;
  private readonly tools: LocalMcpTool[];
  readonly name = 'myco-vault';

  constructor(toolSurface: RuntimeToolSurface) {
    const nameSet = toolSurface.toolNames ? new Set(toolSurface.toolNames) : null;
    const allTools = createVaultTools(toolSurface.agentId, toolSurface.runId, {
      onlyNames: toolSurface.toolNames ? new Set(toolSurface.toolNames) : undefined,
      turnOffset: toolSurface.turnOffset,
      projectRoot: toolSurface.projectRoot,
      vaultDir: toolSurface.vaultDir,
      embeddingManager: toolSurface.embeddingManager,
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

function normalizeInputSchema(schema: Record<string, unknown> | undefined) {
  if (!schema) {
    return {
      type: 'object' as const,
      properties: {},
      required: [],
      additionalProperties: false,
    };
  }

  if (schema.type === 'object' && typeof schema.properties === 'object' && schema.properties !== null) {
    return {
      type: 'object' as const,
      properties: schema.properties as Record<string, unknown>,
      required: Array.isArray(schema.required) ? (schema.required as string[]) : [],
      additionalProperties: schema.additionalProperties === true,
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

export function createLocalVaultMcpServer(toolSurface: RuntimeToolSurface): MCPServer {
  return new LocalVaultMcpServer(toolSurface);
}
