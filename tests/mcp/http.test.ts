import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { vi } from '../helpers/vi-shim.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

function mockClient(): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
      if (endpoint === '/api/digest') {
        return { ok: true, data: { tiers: [{ tier: 5000, content: 'HTTP MCP digest', generated_at: 1 }] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

async function listen(handler: http.RequestListener): Promise<URL> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

describe('streamable HTTP MCP', () => {
  it('lists tools and calls a read-only tool over HTTP', async () => {
    const handler = createStreamableMcpHttpHandler('/tmp/myco-http-mcp', mockClient());
    const url = await listen((req, res) => {
      void handler(req, res);
    });
    const client = new Client({ name: 'myco-http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url);

    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const called = await client.callTool({ name: 'myco_context', arguments: { tier: 5000 } });

    expect(names).toContain('myco_context');
    expect(names).toContain('canopy_map');
    expect(called.content[0]).toEqual({ type: 'text', text: 'HTTP MCP digest' });

    await client.close();
  });
});
