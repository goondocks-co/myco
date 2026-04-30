import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/tool.js';

describe('myco tool CLI', () => {
  let tmpDir: string;
  let originalLog: typeof console.log;
  let logged: string[];
  let servers: http.Server[];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tool-cli-'));
    logged = [];
    servers = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = originalLog;
    for (const server of servers) server.close();
    process.exitCode = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function startDaemonStub(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/digest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tiers: [] }));
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
    fs.writeFileSync(path.join(tmpDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: address.port }), 'utf-8');
  }

  it('lists tools as JSON', async () => {
    await run(['list', '--json'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; result: Array<{ name: string }> };
    expect(output.ok).toBe(true);
    expect(output.result.map((tool) => tool.name)).toContain('myco_context');
  });

  it('calls a tool with inline JSON input', async () => {
    await startDaemonStub();
    await run(['call', 'myco_context', '--json', '--input', '{"tier":5000}'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; tool: string; result: { tier: number } };
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_context');
    expect(output.result.tier).toBe(5000);
  });

  it('calls a tool with @file input', async () => {
    await startDaemonStub();
    const inputPath = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(inputPath, '{"tier":1500}', 'utf-8');

    await run(['call', 'myco_context', '--json', '--input', `@${inputPath}`], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; result: { tier: number } };
    expect(output.ok).toBe(true);
    expect(output.result.tier).toBe(1500);
  });

  it('calls a tool when options appear before the tool name', async () => {
    await startDaemonStub();
    await run(['call', '--json', '--input', '{"tier":5000}', 'myco_context'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; tool: string; result: { tier: number } };
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_context');
    expect(output.result.tier).toBe(5000);
  });

  it('returns an error when --input is missing its value', async () => {
    await run(['call', 'myco_context', '--json', '--input'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; error: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_arguments');
    expect(process.exitCode).toBe(1);
  });

  it('returns invalid_input for non-object JSON input', async () => {
    await run(['call', 'myco_context', '--json', '--input', '"bad"'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; error: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_input');
    expect(process.exitCode).toBe(1);
  });

  it('returns JSON error envelope for invalid JSON', async () => {
    await run(['call', 'myco_context', '--json', '--input', '{bad'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; error: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_json');
    expect(process.exitCode).toBe(1);
  });

  it('returns JSON error envelope for unknown tools', async () => {
    await run(['call', 'missing_tool', '--json', '--input', '{}'], tmpDir);

    const output = JSON.parse(logged[0]) as { ok: boolean; error: { code: string } };
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('unknown_tool');
    expect(process.exitCode).toBe(1);
  });
});
