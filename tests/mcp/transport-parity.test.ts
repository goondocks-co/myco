import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createStreamableMcpHttpHandler as createStreamableMcpHttpHandlerWithDefaults,
} from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { REQUEST_CONTEXT_ENV, requestContextHeaders, resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveDaemonServiceState } from '@myco/daemon/service-state.js';
import { createDaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { vi } from '../helpers/vi-shim.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const createStreamableMcpHttpHandler = (
  vaultDir: string,
  options: Parameters<typeof createStreamableMcpHttpHandlerWithDefaults>[1],
) => createStreamableMcpHttpHandlerWithDefaults(vaultDir, {
  ...options,
  lockNamespace: testPerUserLockNamespace,
});

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
        return { ok: true, data: { tiers: [{ tier: 5000, content: 'transport digest', generated_at: 1 }] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

/**
 * Stub daemon that serves the same routes the real daemon serves to both the
 * MCP HTTP transport and to the stdio bridge:
 *   - `/health` so `DaemonClient.ensureRunning()` returns true.
 *   - `/mcp` via the real `createStreamableMcpHttpHandler` so the bridge
 *     forwards into the same in-process tool runtime the HTTP client uses.
 *   - `/api/digest` and `/api/log` so the cortex tool's daemon round-trips
 *     resolve. (DaemonClient calls these from the in-process tool runtime.)
 */
async function startDaemonStub(vaultDir: string, mcpHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>): Promise<URL> {
  const server = http.createServer((req, res) => {
    if (req.url === '/mcp') {
      void mcpHandler(req, res);
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true }));
      return;
    }
    if (req.url === '/api/digest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tiers: [{ tier: 5000, content: 'transport digest', generated_at: 1 }] }));
      return;
    }
    if (req.url === '/api/log') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  const daemonService = resolveDaemonServiceState(vaultDir, { env: process.env });
  const authority = createDaemonStateAuthority(daemonService, { info: () => {} });
  authority.write({ pid: process.pid, port: address.port }, { reason: 'test:stub-daemon' });
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.MYCO_NO_AUTO_SPAWN = '1';
  Object.assign(env, extra);
  return env;
}

describe('MCP transport parity', () => {
  it('stdio bridge and streamable HTTP route into the same in-process tool runtime', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stdio-mcp-'));
    tmpDirs.push(projectRoot);
    const previousHome = process.env.MYCO_HOME;
    const home = path.join(projectRoot, '.myco-home');
    process.env.MYCO_HOME = home;
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project A' },
      grove: { binding_id: 'gbind-a', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      projectName: 'Project A',
      projectRoot,
      bindingId: 'gbind-a',
    }, home);

    // Single MCP handler serves both transports. The stdio subprocess is a
    // forwarder; the HTTP client connects to the same `/mcp` URL the bridge
    // forwards to. Parity is structural: there is only one runtime.
    const capturedGets: CapturedGet[] = [];
    const mcpHandler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient(capturedGets) });
    const httpUrl = await startDaemonStub(vaultDir, mcpHandler);
    const requestContext = resolveLegacyRequestContext(vaultDir, {
      projectRoot,
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: grove.id,
      machineId: 'machine-a',
      sessionId: 'sess-a',
      source: 'explicit',
    });

    const stdioClient = new Client({ name: 'myco-stdio-test', version: '1.0.0' });
    const httpClient = new Client({ name: 'myco-http-test', version: '1.0.0' });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('packages/myco/src/cli.ts'), 'mcp'],
      cwd: projectRoot,
      env: childEnv({
        [REQUEST_CONTEXT_ENV.projectRoot]: projectRoot,
        [REQUEST_CONTEXT_ENV.projectId]: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        [REQUEST_CONTEXT_ENV.groveId]: grove.id,
        [REQUEST_CONTEXT_ENV.machineId]: 'machine-a',
        [REQUEST_CONTEXT_ENV.sessionId]: 'sess-a',
        MYCO_HOME: home,
      }),
      stderr: 'pipe',
    });
    const httpTransport = new StreamableHTTPClientTransport(httpUrl, {
      requestInit: { headers: requestContextHeaders(requestContext) },
    });

    try {
      await stdioClient.connect(stdioTransport);
      await httpClient.connect(httpTransport);

      const stdioList = await stdioClient.listTools();
      const httpList = await httpClient.listTools();
      const stdioNames = stdioList.tools.map((tool) => tool.name).sort();
      const httpNames = httpList.tools.map((tool) => tool.name).sort();
      const stdioCall = await stdioClient.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });
      const httpCall = await httpClient.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });

      expect(stdioNames).toEqual(httpNames);
      expect(stdioNames).toContain('myco_cortex');
      expect(stdioNames).toContain('myco_spores');
      expect(stdioCall.content[0]).toEqual({ type: 'text', text: 'transport digest' });
      expect(httpCall.content[0]).toEqual({ type: 'text', text: 'transport digest' });
      const digestHeaders = capturedGets
        .filter((call) => call.endpoint === '/api/digest')
        .map((call) => call.options?.headers);
      expect(digestHeaders).toHaveLength(2);
      expect(digestHeaders).toEqual([
        expect.objectContaining({
          'x-myco-project-root': projectRoot,
          'x-myco-project-id': 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'x-myco-grove-id': grove.id,
          'x-myco-machine-id': 'machine-a',
          'x-myco-session-id': 'sess-a',
        }),
        expect.objectContaining({
          'x-myco-project-root': projectRoot,
          'x-myco-project-id': 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'x-myco-grove-id': grove.id,
          'x-myco-machine-id': 'machine-a',
          'x-myco-session-id': 'sess-a',
        }),
      ]);
    } finally {
      await Promise.allSettled([stdioClient.close(), httpClient.close()]);
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
    }
  });
});
