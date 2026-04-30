import { describe, it, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { vi } from '../helpers/vi-shim.js';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.length = 0;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function mockClient(): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
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

async function listen(handler: http.RequestListener): Promise<URL> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

async function startDaemonStub(vaultDir: string): Promise<void> {
  const server = http.createServer((req, res) => {
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
  fs.writeFileSync(path.join(vaultDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: address.port }), 'utf-8');
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.MYCO_NO_AUTO_SPAWN = '1';
  return env;
}

describe('MCP transport parity', () => {
  it('stdio and streamable HTTP expose the same tool surface and read-only call shape', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stdio-mcp-'));
    tmpDirs.push(projectRoot);
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\nconfig_version: 0\n', 'utf-8');
    await startDaemonStub(vaultDir);

    const httpHandler = createStreamableMcpHttpHandler(vaultDir, mockClient());
    const httpUrl = await listen((req, res) => {
      void httpHandler(req, res);
    });

    const stdioClient = new Client({ name: 'myco-stdio-test', version: '1.0.0' });
    const httpClient = new Client({ name: 'myco-http-test', version: '1.0.0' });
    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve('packages/myco/src/cli.ts'), 'mcp'],
      cwd: projectRoot,
      env: childEnv(),
      stderr: 'pipe',
    });
    const httpTransport = new StreamableHTTPClientTransport(httpUrl);

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
    } finally {
      await Promise.allSettled([stdioClient.close(), httpClient.close()]);
    }
  });
});
