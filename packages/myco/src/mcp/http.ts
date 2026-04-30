import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DaemonClient } from '../hooks/client.js';
import { createMycoTools } from '../tools/index.js';
import { createMcpProtocolServer } from './server.js';

export type StreamableMcpHttpHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export function createStreamableMcpHttpHandler(
  vaultDir: string,
  client: DaemonClient = new DaemonClient(vaultDir),
): StreamableMcpHttpHandler {
  // Build the shared tools registry once per handler factory: it owns the
  // dbReady/logDirReady caches and 16 handler closures, all stateless across
  // requests. The MCP SDK's stateless streamable-http pattern (sessionIdGenerator
  // undefined) expects a fresh Server + Transport per request, so those stay
  // request-scoped.
  const tools = createMycoTools(vaultDir, client);

  return async (req, res) => {
    const server = createMcpProtocolServer(tools);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  };
}
