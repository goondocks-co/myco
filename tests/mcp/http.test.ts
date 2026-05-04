import { describe, it, expect, afterEach } from 'bun:test';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { requestContextHeaders, resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { vi } from '../helpers/vi-shim.js';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
});

interface CapturedGet {
  endpoint: string;
  options?: { headers?: Record<string, string> };
}

function mockClient(capturedGets: CapturedGet[] = []): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string, options?: { headers?: Record<string, string> }) => {
      capturedGets.push({ endpoint, options });
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
    const called = await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });

    expect(names).toContain('myco_cortex');
    expect(names).toContain('myco_spores');
    expect(called.content[0]).toEqual({ type: 'text', text: 'HTTP MCP digest' });

    await client.close();
  });

  it('passes HTTP request context headers into the shared tool runtime', async () => {
    const capturedGets: CapturedGet[] = [];
    const handler = createStreamableMcpHttpHandler('/tmp/myco-http-mcp', mockClient(capturedGets));
    const url = await listen((req, res) => {
      void handler(req, res);
    });
    const requestContext = resolveLegacyRequestContext('/tmp/project-a/.myco', {
      projectRoot: '/tmp/project-a',
      projectId: 'project-a',
      groveId: 'grove-a',
      machineId: 'machine-a',
      sessionId: 'sess-a',
      source: 'explicit',
    });
    const client = new Client({ name: 'myco-http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: requestContextHeaders(requestContext) },
    });

    await client.connect(transport);
    await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });
    await client.close();

    const digestCall = capturedGets.find((call) => call.endpoint === '/api/digest');
    expect(digestCall?.options?.headers).toMatchObject({
      'x-myco-project-root': '/tmp/project-a',
      'x-myco-project-id': 'project-a',
      'x-myco-grove-id': 'grove-a',
      'x-myco-machine-id': 'machine-a',
      'x-myco-session-id': 'sess-a',
    });
  });
});
