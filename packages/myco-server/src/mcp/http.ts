/**
 * `POST /mcp`: Streamable HTTP MCP for an authenticated member.
 *
 * The pipeline has authenticated the credential, admitted the Project, and read
 * the body. This builds the request the transport expects — the body as
 * JSON-RPC, with the content and accept headers the transport requires — and
 * answers through a transport that keeps no session and streams nothing: one
 * POST, one JSON response, per request. A body that is not JSON-RPC is refused
 * in the route's shape, the same envelope the pipeline's own refusals carry.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { SERVER_PROTOCOL } from '../constants.js';
import { toolContext } from './context.js';
import { createProtocolServer } from './server.js';

/** The refusal an `answered` route gives a body that is not JSON-RPC: the pipeline's shape, the `parse` classifier. */
export function jsonRpcRefusal(reason: string, code: string, status: number): Response {
  return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: reason, data: { code } } }, { status });
}

/** True when the parsed body has the one field every JSON-RPC message carries. */
function isJsonRpc(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0 && body.every(isJsonRpc);
  return typeof body === 'object' && body !== null && (body as { jsonrpc?: unknown }).jsonrpc === '2.0';
}

export async function handleMcp(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return jsonRpcRefusal('body is not JSON', 'parse', 400);
  }
  if (!isJsonRpc(parsed)) return jsonRpcRefusal('body is not a JSON-RPC 2.0 message', 'parse', 400);

  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // A storage fault inside a call is the Deployment's failure, answered by the
  // pipeline as retryable; the transport's own answer to the throw is discarded.
  let fault: unknown;
  const server = createProtocolServer(toolContext(env, ctx), String(SERVER_PROTOCOL), (err) => { fault = err; });
  await server.connect(transport);
  try {
    const request = new Request('https://deployment/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: ctx.body,
    });
    const response = await transport.handleRequest(request, { parsedBody: parsed });
    if (fault !== undefined) throw fault;
    return response;
  } finally {
    await server.close();
  }
}
