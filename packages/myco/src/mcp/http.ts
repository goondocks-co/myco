import type http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Database } from '../db/client.js';
import { DaemonClient } from '../hooks/client.js';
import { createMycoTools } from '../tools/index.js';
import {
  requestContextFromHttpHeaders,
  tryResolveRequestContextForVault,
} from '../tools/request-context.js';
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

/**
 * Pre-flight legacy-vault check. Pre-Grove vaults — those without a
 * `project.toml` containing a Grove project id — would otherwise
 * cause `requestContextFromHttpHeaders` to throw inside the MCP
 * handler and surface as the opaque `tool_call_failed` JSON-RPC
 * error. Detect that state up front and return a structured 503
 * with a `legacy_vault` discriminator + a friendly message that
 * tells the user to run `myco init`.
 *
 * Only triggers when the incoming request has *not* supplied
 * project-context headers — Grove-bound transports always do, so
 * the soft-fail path is reserved for callers that bind to the
 * vault directory alone (legacy CLI-style HTTP MCP clients).
 */
function checkLegacyVault(req: http.IncomingMessage, vaultDir: string): { ok: false; body: string } | { ok: true } {
  const hasContextHeaders = ['x-myco-project-root', 'x-myco-project-id', 'x-myco-grove-id']
    .some((header) => typeof req.headers[header] === 'string' && (req.headers[header] as string).trim().length > 0);
  if (hasContextHeaders) return { ok: true };

  const result = tryResolveRequestContextForVault(vaultDir);
  if (result.kind === 'grove') return { ok: true };

  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32004,
      message: result.reason,
      data: { code: 'legacy_vault', vault_dir: result.vaultDir },
    },
    id: null,
  });
  return { ok: false, body };
}

export function createStreamableMcpHttpHandler(
  vaultDir: string,
  options: StreamableMcpHttpHandlerOptions = {},
): StreamableMcpHttpHandler {
  const client = options.client ?? new DaemonClient(vaultDir);
  return async (req, res) => {
    const legacyCheck = checkLegacyVault(req, vaultDir);
    if (!legacyCheck.ok) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(legacyCheck.body);
      return;
    }
    // G4: when the daemon has minted a bearer token (via env), enforce
    // the same context-switch gate the daemon's main HTTP server uses.
    const requestContext = requestContextFromHttpHeaders(req.headers, vaultDir, {
      expectedAuthToken: process.env.MYCO_DAEMON_AUTH ?? null,
    });
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
