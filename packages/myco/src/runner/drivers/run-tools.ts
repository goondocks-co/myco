/**
 * The tools the run's own server serves this run, read from the server itself.
 *
 * A harness names a tool of the run's server in its own way, and a name alone
 * cannot tell the run's server from another server with a similar name. The
 * run's credential lists exactly the tools the run is allowed, so a driver that
 * has to recognise the run's tools by name compares against this list.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { withMcpClient } from '../../mcp/client-call.js';

/** Where the run's server is, and the headers that carry the run's credential. */
export interface RunServer {
  url: string;
  headers: Record<string, string>;
}

/** The names of the tools the run's server serves, or why they could not be read. */
export type RunTools = { ok: true; names: ReadonlySet<string> } | { ok: false; reason: string };

/** Every tool the run's server lists for the run's credential; the client reads every page. */
export async function listRunTools(server: RunServer): Promise<RunTools> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  const listed = await withMcpClient(transport, async (client) => new Set((await client.listTools()).tools.map((tool) => tool.name)));
  return listed.ok ? { ok: true, names: listed.value } : { ok: false, reason: `${listed.error.code}: ${listed.error.message}` };
}
