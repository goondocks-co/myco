import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createStreamableMcpHttpHandler as createStreamableMcpHttpHandlerWithDefaults,
} from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { requestContextHeaders, resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import { markTeamRequest } from '@myco/daemon/host-serve.js';
import { managedBinaryPath } from '@myco/install/managed-binary.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-'));
    const vaultDir = path.join(tmp, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project HTTP MCP' },
    });
    const handler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient() });
    const url = await listen((req, res) => {
      void handler(req, res);
    });
    const client = new Client({ name: 'myco-http-test', version: '1.0.0' });
    // Real MCP clients (the stdio bridge) always send request-context
    // headers derived from env; the shared runtime requires caller-supplied
    // tenancy, so a headerless tool call is the leak case the runtime now
    // rejects. Send the project-id header like a real symbiont would.
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { 'x-myco-project-id': 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      },
    });

    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    const called = await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });

    expect(names).toContain('myco_cortex');
    expect(names).toContain('myco_spores');
    expect(called.content[0]).toEqual({ type: 'text', text: 'HTTP MCP digest' });

    await client.close();
  });

  it('op:instructions over an overlay-marked request renders the bare invocation, never this host\'s path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-overlay-'));
    tmpDirs.push(tmp);
    const home = path.join(tmp, 'home');
    const savedHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const grove = createGrove('Overlay', home);
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Project Overlay' },
      grove: { binding_id: 'gbind-b', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      projectName: 'Project Overlay',
      projectRoot,
      bindingId: 'gbind-b',
    }, home);
    // A runnable managed binary in this host's home: a LOCAL cli caller would
    // resolve this path; the overlay caller must not receive it.
    const managed = managedBinaryPath(home, process.platform, process.env.LOCALAPPDATA);
    fs.mkdirSync(path.dirname(managed), { recursive: true });
    fs.writeFileSync(managed, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      const instructionsClient = {
        ...mockClient(),
        get: vi.fn(async (endpoint: string) => {
          if (endpoint === '/api/cortex/instructions') {
            return { ok: true, data: { content: 'BODY', generatedAt: 1, stored: true } };
          }
          return { ok: true, data: {} };
        }),
      } as unknown as DaemonClient;
      const handler = createStreamableMcpHttpHandler(vaultDir, {
        client: instructionsClient,
        hostServe: { servedGroveId: grove.id },
      });
      const url = await listen((req, res) => {
        markTeamRequest(req);
        void handler(req, res);
      });
      const requestContext = resolveLegacyRequestContext(vaultDir, {
        projectRoot,
        projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        groveId: grove.id,
        machineId: 'machine-b',
        source: 'explicit',
      });
      const client = new Client({ name: 'myco-http-test', version: '1.0.0' });
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { ...requestContextHeaders(requestContext), 'x-myco-tool-transport': 'cli' },
        },
      });
      await client.connect(transport);
      const called = await client.callTool({ name: 'myco_cortex', arguments: { op: 'instructions' } });
      const text = (called.content as Array<{ type: string; text: string }>)[0].text;
      expect(text).toContain('`myco tool call <tool>');
      expect(text).not.toContain(managed);
      await client.close();
    } finally {
      if (savedHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = savedHome;
    }
  });

  it('rejects a headerless tool call with the legacy_vault wire error (no silent anchor default)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-legacy-'));
    tmpDirs.push(tmp);
    const vaultDir = path.join(tmp, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project HTTP MCP' },
    });
    const handler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient() });
    const url = await listen((req, res) => {
      void handler(req, res);
    });

    // Raw POST without request-context headers: the transport must translate
    // the shared runtime's caller-tenancy policy into the structured 503 +
    // legacy_vault discriminator, NOT silently resolve the anchor vault.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } },
    });
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });
    expect(response.status).toBe(503);
    const payload = await response.json() as { error?: { data?: { code?: string } } };
    expect(payload.error?.data?.code).toBe('legacy_vault');
  });

  it('rejects an unauthorized context-switch with a 401, not a generic 500', async () => {
    const previousAuth = process.env.MYCO_DAEMON_AUTH;
    process.env.MYCO_DAEMON_AUTH = 'daemon-secret-token';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-unauth-'));
    tmpDirs.push(tmp);
    const vaultDir = path.join(tmp, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    saveProjectManifest(vaultDir, {
      project: { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Project HTTP MCP' },
    });
    const handler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient() });
    const url = await listen((req, res) => {
      void handler(req, res);
    });

    // Context-switch header present (x-myco-project-id) but no matching
    // x-myco-auth bearer: the daemon's context-switch gate rejects with
    // UnauthorizedRequestContextError. The /mcp transport must translate
    // that to the same 401 `unauthorized_context_switch` contract the main
    // HTTP path uses, NOT let it become a generic -32603/500.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } },
    });
    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-myco-project-id': 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        body,
      });
      expect(response.status).toBe(401);
      const payload = await response.json() as { error?: string };
      expect(payload.error).toBe('unauthorized_context_switch');
    } finally {
      if (previousAuth === undefined) delete process.env.MYCO_DAEMON_AUTH;
      else process.env.MYCO_DAEMON_AUTH = previousAuth;
    }
  });

  it('passes HTTP request context headers into the shared tool runtime', async () => {
    const previousHome = process.env.MYCO_HOME;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-context-'));
    tmpDirs.push(tmp);
    const home = path.join(tmp, 'home');
    process.env.MYCO_HOME = home;
    const projectRoot = path.join(tmp, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
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
    const capturedGets: CapturedGet[] = [];
    const handler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient(capturedGets) });
    const url = await listen((req, res) => {
      void handler(req, res);
    });
    const requestContext = resolveLegacyRequestContext(vaultDir, {
      projectRoot,
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
      'x-myco-project-id': 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'x-myco-grove-id': grove.id,
      'x-myco-machine-id': 'machine-a',
      'x-myco-session-id': 'sess-a',
    });
  });

  it('rejects a Grove that lives in another home, not the legacy_vault 503', async () => {
    const previousHome = process.env.MYCO_HOME;
    const previousVariant = process.env.MYCO_SERVICE_VARIANT;
    // Env mutation and fixture setup live inside the try so a setup
    // throw can't leak MYCO_HOME / MYCO_SERVICE_VARIANT into later tests.
    try {
      delete process.env.MYCO_SERVICE_VARIANT;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-http-mcp-foreign-'));
      tmpDirs.push(tmp);
      const home = path.join(tmp, 'home');
      const foreignHome = path.join(tmp, 'home-B');
      fs.mkdirSync(foreignHome, { recursive: true });
      // This handler runs under home A (MYCO_HOME); the Grove + project
      // live under home B, so home-scoped resolution must refuse them up
      // front rather than misclassifying as legacy_vault.
      process.env.MYCO_HOME = home;
      const projectRoot = path.join(tmp, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      const vaultDir = path.join(projectRoot, '.myco');
      fs.mkdirSync(vaultDir, { recursive: true });
      const grove = createGrove('Dogfood', foreignHome);
      saveProjectManifest(vaultDir, {
        project: { id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Project B' },
        grove: { binding_id: 'gbind-b', slug: grove.slug, mode: 'local' },
      });
      registerProjectInGrove(grove.id, {
        projectId: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        projectName: 'Project B',
        projectRoot,
        bindingId: 'gbind-b',
      }, foreignHome);
      const handler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient() });
      const url = await listen((req, res) => {
        void handler(req, res);
      });

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } },
      });
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-myco-grove-id': grove.id,
          'x-myco-project-id': 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        body,
      });
      // A foreign-home Grove is unknown to this daemon → 404 unknown_tenancy.
      // The regression this guards is that it is NOT the legacy_vault 503.
      expect(response.status).toBe(404);
      const payload = await response.json() as { error?: string };
      expect(payload.error).toBe('unknown_tenancy');
      expect(payload.error).not.toBe('legacy_vault');
    } finally {
      if (previousHome === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previousHome;
      if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
      else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    }
  });
});
