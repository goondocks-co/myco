import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../db/client.js';
import { DaemonClient } from '../hooks/client.js';
import { createMycoTools } from '../tools/index.js';
import { requestContextFromHttpHeaders } from '../tools/request-context.js';
import { createMcpProtocolServer } from './server.js';

export type StreamableMcpHttpHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

export interface StreamableMcpHttpHandlerOptions {
  client?: DaemonClient;
  /** Reuse the daemon's runtime cache so tool calls don't open per-call DB handles. */
  resolveDatabase?: (databasePath: string) => Database;
}

export function createStreamableMcpHttpHandler(
  vaultDir: string,
  options: StreamableMcpHttpHandlerOptions = {},
): StreamableMcpHttpHandler {
  const client = options.client ?? new DaemonClient(vaultDir);
  return async (req, res) => {
    const requestContext = requestContextFromHttpHeaders(req.headers, vaultDir);
    const tools = createMycoTools(vaultDir, client, {
      requestContext,
      resolveDatabase: options.resolveDatabase,
    });
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
