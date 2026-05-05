import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { requestContextHeaders, resolveLegacyRequestContext } from '@myco/tools/request-context.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { vi } from '../helpers/vi-shim.js';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
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
    const previousHome = process.env.MYCO_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-context-'));
    tmpDirs.push(tmp);
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'project-a');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: 'project-a', name: 'Project A' },
      grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'project-a',
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind-a',
    }, home);
    const capturedGets: CapturedGet[] = [];
    const handler = createStreamableMcpHttpHandler(vaultDir, mockClient(capturedGets));
    const url = await listen((req, res) => {
      void handler(req, res);
    });
    const requestContext = resolveLegacyRequestContext(vaultDir, {
      projectRoot,
      projectId: 'project-a',
      groveId: grove.id,
      machineId: 'machine-a',
      sessionId: 'sess-a',
      source: 'explicit',
    });
    const client = new Client({ name: 'myco-http-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: requestContextHeaders(requestContext) },
    });

    try {
      await client.connect(transport);
      await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });
      await client.close();
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
    }

    const digestCall = capturedGets.find((call) => call.endpoint === '/api/digest');
    expect(digestCall?.options?.headers).toMatchObject({
      'x-myco-project-root': projectRoot,
      'x-myco-project-id': 'project-a',
      'x-myco-grove-id': grove.id,
      'x-myco-machine-id': 'machine-a',
      'x-myco-session-id': 'sess-a',
    });
  });
});
