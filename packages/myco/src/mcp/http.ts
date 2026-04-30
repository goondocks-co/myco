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
  return async (req, res) => {
    const tools = createMycoTools(vaultDir, client);
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
