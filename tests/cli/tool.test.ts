import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/tool.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { openDatabase, withDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { REQUEST_CONTEXT_ENV, REQUEST_CONTEXT_HEADERS } from '@myco/tools/request-context.js';
import { cleanTestDb, setupTestDb, teardownTestDb } from '../helpers/db.js';
import { vi } from '../helpers/vi-shim.js';

describe('myco tool CLI', () => {
  let tmpDir: string;
  let originalStdoutWrite: typeof process.stdout.write;
  let written: string[];
  let servers: http.Server[];
  let digestHeaders: http.IncomingHttpHeaders[];

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tool-cli-'));
    ensureProjectManifest(tmpDir, { projectName: 'tool-cli-test' });
    written = [];
    servers = [];
    digestHeaders = [];
    cleanTestDb();
    originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      written.push(Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
      const done = typeof encodingOrCallback === 'function'
        ? encodingOrCallback
        : typeof callback === 'function'
          ? callback
          : undefined;
      if (done) done();
      return true;
    }) as typeof process.stdout.write;
    process.exitCode = 0;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    vi.unstubAllEnvs();
    for (const server of servers) server.close();
    process.exitCode = 0;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterAll(() => {
    teardownTestDb();
  });

  function outputJson<T>(): T {
    return JSON.parse(written.join('')) as T;
  }

  async function startDaemonStub(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/digest') {
        digestHeaders.push(req.headers);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tiers: [] }));
        return;
      }
      if (req.url === '/api/log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.startsWith('/api/mcp/plans')) {
        const url = new URL(req.url, 'http://127.0.0.1');
        const id = url.searchParams.get('id') ?? 'plan-1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          plans: [{
            id,
            title: 'Large plan',
            status: 'active',
            progress: 'planned',
            tags: [],
            created_at: Date.now(),
            content: 'x'.repeat(70_000),
          }],
        }));
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

    const output = outputJson<{ ok: boolean; result: Array<{ name: string }> }>();
    expect(output.ok).toBe(true);
    expect(output.result.map((tool) => tool.name)).toContain('myco_cortex');
  });

  it('calls a tool with inline JSON input', async () => {
    await startDaemonStub();
    await run(['call', 'myco_cortex', '--json', '--input', '{"op":"digest","tier":5000}'], tmpDir);

    const output = outputJson<{ ok: boolean; tool: string; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_cortex');
    expect(output.result.tier).toBe(5000);
  });

  it('forwards explicit environment request context to daemon-backed tools', async () => {
    const home = path.join(tmpDir, 'home');
    const projectRoot = path.join(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const { saveProjectManifest } = await import('@myco/config/project-manifest.js');
    const { createGrove, registerProjectInGrove } = await import('@myco/grove/registry.js');
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

    vi.stubEnv('MYCO_HOME', home);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
    vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');
    vi.stubEnv(REQUEST_CONTEXT_ENV.sessionId, 'sess-a');
    await startDaemonStub();

    await run(['call', 'myco_cortex', '--json', '--input', '{"op":"digest","tier":5000}'], tmpDir);

    const output = outputJson<{ ok: boolean }>();
    expect(output.ok).toBe(true);
    expect(digestHeaders.at(-1)?.[REQUEST_CONTEXT_HEADERS.projectRoot]).toBe(projectRoot);
    expect(digestHeaders.at(-1)?.[REQUEST_CONTEXT_HEADERS.projectId]).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(digestHeaders.at(-1)?.[REQUEST_CONTEXT_HEADERS.groveId]).toBe(grove.id);
    expect(digestHeaders.at(-1)?.[REQUEST_CONTEXT_HEADERS.machineId]).toBe('machine-a');
    expect(digestHeaders.at(-1)?.[REQUEST_CONTEXT_HEADERS.sessionId]).toBe('sess-a');
  });

  it('calls a tool with @file input', async () => {
    await startDaemonStub();
    const inputPath = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(inputPath, '{"op":"digest","tier":1500}', 'utf-8');

    await run(['call', 'myco_cortex', '--json', '--input', `@${inputPath}`], tmpDir);

    const output = outputJson<{ ok: boolean; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.result.tier).toBe(1500);
  });

  it('calls a tool when options appear before the tool name', async () => {
    await startDaemonStub();
    await run(['call', '--json', '--input', '{"op":"digest","tier":5000}', 'myco_cortex'], tmpDir);

    const output = outputJson<{ ok: boolean; tool: string; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_cortex');
    expect(output.result.tier).toBe(5000);
  });

  it('flushes large JSON tool output before returning', async () => {
    await startDaemonStub();
    const db = openDatabase(path.join(tmpDir, 'myco.db'));
    try {
      createSchema(db);
      withDatabase(db, () => {
        upsertPlan({
          id: 'large-plan',
          logical_key: 'session:s:key:large-plan',
          title: 'Large plan',
          content: 'x'.repeat(70_000),
          tags: null,
          status: 'active',
          created_at: 1700000000,
          machine_id: 'local',
        });
      });
    } finally {
      db.close();
    }

    await run(['call', 'myco_plans', '--json', '--input', '{"op":"get","id":"large-plan"}'], tmpDir);

    const raw = written.join('');
    const output = JSON.parse(raw) as { ok: boolean; result: { id: string; content: string } };
    expect(output.ok).toBe(true);
    expect(output.result.id).toBe('large-plan');
    expect(output.result.content.length).toBe(70_000);
    expect(raw.length).toBeGreaterThan(65_536);
  });

  it('returns an error when --input is missing its value', async () => {
    await run(['call', 'myco_cortex', '--json', '--input'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_arguments');
    expect(process.exitCode).toBe(1);
  });

  it('returns invalid_input for non-object JSON input', async () => {
    await run(['call', 'myco_cortex', '--json', '--input', '"bad"'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_input');
    expect(process.exitCode).toBe(1);
  });

  it('returns JSON error envelope for invalid JSON', async () => {
    await run(['call', 'myco_cortex', '--json', '--input', '{bad'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('invalid_json');
    expect(process.exitCode).toBe(1);
  });

  it('returns JSON error envelope for unknown tools', async () => {
    await run(['call', 'missing_tool', '--json', '--input', '{}'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('unknown_tool');
    expect(process.exitCode).toBe(1);
  });
});
