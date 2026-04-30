import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getPluginVersion } from '../version.js';
import { resolveVaultDir } from '../vault/resolve.js';
import { DaemonClient } from '../hooks/client.js';
import { TOOL_CONTEXT, type ToolDefinition } from '../tools/definitions.js';
import { createMycoTools, type MycoTools } from '../tools/index.js';

export interface MycoServer {
  name: string;
  getRegisteredTools(): string[];
  start(): Promise<void>;
}

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
  if (name === TOOL_CONTEXT && isContextResult(result)) return result.content;
  return JSON.stringify(result);
}

function isContextResult(result: unknown): result is { content: string } {
  return typeof result === 'object'
    && result !== null
    && typeof (result as { content?: unknown }).content === 'string';
}

export function createMycoServer(vaultDir: string, client: DaemonClient): MycoServer {
  const tools = createMycoTools(vaultDir, client);
  const server = createMcpProtocolServer(tools);

  return {
    name: 'myco',
    getRegisteredTools() {
      return tools.getRegisteredTools();
    },
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
    },
  };
}

export async function main(): Promise<void> {
  const vaultDir = resolveVaultDir();
  const client = new DaemonClient(vaultDir);
  const server = createMycoServer(vaultDir, client);
  await server.start();
}
