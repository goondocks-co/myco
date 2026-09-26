/**
 * The run's MCP server, reached through the global `fetch`, for a test that
 * drives a run through the worker.
 *
 * A driver lists the run's tools over its own MCP client before it opens a
 * session, and that client calls the global `fetch`: a worker test that stubs
 * only the worker's injected fetch leaves the listing to reach the network. This
 * routes the run server's `/mcp` requests to an answer the test chooses, and
 * every other request to the fetch it replaced, for the length of one call.
 */
import { globalFetchDouble } from './global-fetch.js';

/** An MCP server that lists these tools and answers nothing else, as the stateless streamable HTTP transport is answered. */
export async function listingOnly(request: Request, tools: readonly string[] = []): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  const message = await request.json() as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (message.id === undefined) return new Response(null, { status: 202 });
  if (message.method === 'initialize') {
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'myco', version: '0' } } });
  }
  if (message.method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools: tools.map((name) => ({ name, inputSchema: { type: 'object' } })) } });
  }
  return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
}

/** Run `fn` with the global `fetch` answering `<origin>/mcp` through `answer`. */
export async function withRunMcp<T>(origin: string, answer: (request: Request) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const endpoint = new URL('/mcp', origin).toString();
  globalThis.fetch = globalFetchDouble(async (input, init) => {
    const request = new Request(input instanceof Request ? input : String(input), init);
    return request.url === endpoint ? answer(request) : original(input, init);
  });
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}
