import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPluginVersion } from '../version.js';
import { TOOL_CORTEX, type ToolDefinition } from '../tools/definitions.js';
import { type MycoTools } from '../tools/index.js';

export function createMcpProtocolServer(tools: MycoTools): Server {
  const server = new Server(
    { name: 'myco', version: getPluginVersion() },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await tools.listTools() as ToolDefinition[],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const result = await tools.callTool(name, args);
    return { content: [{ type: 'text', text: serializeToolResult(name, result) }] };
  });

  return server;
}

export function serializeToolResult(name: string, result: unknown): string {
  if (name === TOOL_CORTEX && isDigestResult(result)) return result.content;
  return JSON.stringify(result);
}

function isDigestResult(result: unknown): result is { content: string; tier: number; fallback: boolean } {
  return typeof result === 'object'
    && result !== null
    && typeof (result as { content?: unknown }).content === 'string'
    && typeof (result as { tier?: unknown }).tier === 'number'
    && typeof (result as { fallback?: unknown }).fallback === 'boolean';
}
