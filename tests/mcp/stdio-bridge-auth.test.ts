import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import {
  REQUEST_CONTEXT_AUTH_ENV,
  REQUEST_CONTEXT_ENV,
} from '@myco/tools/request-context.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveDaemonServiceState } from '@myco/daemon/service-state.js';
import { createDaemonStateAuthority } from '@myco/daemon/daemon-state-authority.js';
import { vi } from '../helpers/vi-shim.js';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];
let savedEnv: Record<string, string | undefined> = {};

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
  for (const [key, prior] of Object.entries(savedEnv)) {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  savedEnv = {};
});

function saveEnv(...keys: string[]): void {
  for (const key of keys) savedEnv[key] = process.env[key];
}

function mockClient(): DaemonClient {
  return {
    get: vi.fn(async () => ({ ok: true, data: {} })),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

/**
 * Stub daemon mirroring the real daemon's raw-route wrapping: the /mcp
 * handler throws on auth failure, which the daemon's request handler
 * converts into the `-32603 Internal server error` JSON-RPC envelope the
 * bug report observed. Tests assert the bridge clears the gate, so they
 * never need to observe the unauthorized branch directly.
 */
async function startDaemonStub(
  vaultDir: string,
  mcpHandler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>,
  authToken: string,
): Promise<void> {
  const server = http.createServer((req, res) => {
    if (req.url === '/mcp') {
      void mcpHandler(req, res).catch((err: Error) => {
        if (res.headersSent) return;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error', data: err.message },
          id: null,
        }));
      });
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myco: true }));
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
  authority.write({
    pid: process.pid,
    port: address.port,
    auth_token: authToken,
  }, { reason: 'test:stub-daemon' });
}

function childEnv(strip: string[], extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !strip.includes(key)) env[key] = value;
  }
  env.MYCO_NO_AUTO_SPAWN = '1';
  Object.assign(env, extra);
  return env;
}

describe('MCP stdio bridge auth', () => {
  it('forwards the daemon-issued bearer token so context-switching requests pass the gate', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stdio-auth-'));
    tmpDirs.push(projectRoot);
    saveEnv('MYCO_HOME', REQUEST_CONTEXT_AUTH_ENV);
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

    const authToken = 'test-bearer-9f3a';
    // The /mcp handler runs in this (test) process and reads
    // MYCO_DAEMON_AUTH from its own env to enable the gate.
    process.env[REQUEST_CONTEXT_AUTH_ENV] = authToken;
    const mcpHandler = createStreamableMcpHttpHandler(vaultDir, { client: mockClient() });
    await startDaemonStub(vaultDir, mcpHandler, authToken);

    const stdioClient = new Client({ name: 'myco-stdio-auth-test', version: '1.0.0' });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('packages/myco/src/cli.ts'), 'mcp'],
      cwd: projectRoot,
      // Strip MYCO_DAEMON_AUTH from the child env so the bridge MUST recover
      // the token from daemon.json. Without this strip the env would leak the
      // bearer to a separate code path and mask the bridge-side defect.
      env: childEnv([REQUEST_CONTEXT_AUTH_ENV], {
        [REQUEST_CONTEXT_ENV.projectRoot]: projectRoot,
        [REQUEST_CONTEXT_ENV.projectId]: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        [REQUEST_CONTEXT_ENV.groveId]: grove.id,
        [REQUEST_CONTEXT_ENV.machineId]: 'machine-a',
        [REQUEST_CONTEXT_ENV.sessionId]: 'sess-a',
        MYCO_HOME: home,
      }),
      stderr: 'pipe',
    });

    try {
      await stdioClient.connect(stdioTransport);
      const list = await stdioClient.listTools();
      expect(list.tools.length).toBeGreaterThan(0);
    } finally {
      await stdioClient.close().catch(() => undefined);
    }
  }, 30_000);
});
