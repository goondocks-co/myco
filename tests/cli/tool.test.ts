import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { run } from '@myco/cli/tool.js';
import { createStreamableMcpHttpHandler } from '@myco/mcp/http.js';
import type { DaemonClient } from '@myco/hooks/client.js';
import { saveProjectManifest } from '@myco/config/project-manifest.js';
import { openDatabase, withDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { REQUEST_CONTEXT_ENV, REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context.js';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { resolveGroveDbPath, resolveServiceDaemonStatePath } from '@myco/grove/paths.js';
import { upsertHost, writeHostSecret } from '@myco/host/registry.js';
import { HOST_BEARER_SECRET } from '@myco/constants.js';
import { cleanTestDb, setupTestDb, teardownTestDb } from '../helpers/db.js';
import { vi } from '../helpers/vi-shim.js';

const CLI_PROJECT_ID = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** Minimal `DaemonClient` stand-in for the LOCAL daemon's `/mcp` handler.
 *  Only `get('/api/digest', ...)` is exercised by the tools under test
 *  (`myco_cortex`); every other verb/endpoint (e.g. the collective-enabled
 *  probe at `/api/team/status`) is a harmless no-op ack. `digestHeaders`
 *  collects just the headers of each `/api/digest` call, in order — the
 *  same shape `tests/mcp/http.test.ts`'s `mockClient` captures. */
function mockDaemonClient(digestHeaders: http.IncomingHttpHeaders[] = []): DaemonClient {
  return {
    get: (async (endpoint: string, options?: { headers?: Record<string, string> }) => {
      if (endpoint === '/api/digest') {
        digestHeaders.push((options?.headers ?? {}) as http.IncomingHttpHeaders);
        return {
          ok: true,
          data: {
            tiers: [
              { tier: 5000, content: 'digest-5000', generated_at: 1 },
              { tier: 1500, content: 'digest-1500', generated_at: 1 },
            ],
          },
        };
      }
      return { ok: true, data: {} };
    }) as DaemonClient['get'],
    post: (async () => ({ ok: true, data: {} })) as DaemonClient['post'],
    put: (async () => ({ ok: true, data: {} })) as DaemonClient['put'],
    delete: (async () => ({ ok: true, data: {} })) as DaemonClient['delete'],
  } as unknown as DaemonClient;
}

describe('myco tool CLI', () => {
  // Mkdtemp root, removed in afterEach.
  let rootDir: string;
  // Grove-bound vault dir handed to `run` — what the CLI binds to.
  let tmpDir: string;
  let originalStdoutWrite: typeof process.stdout.write;
  let written: string[];
  let servers: http.Server[];
  let digestHeaders: http.IncomingHttpHeaders[];
  // Grove DB the CLI resolves to under the stubbed caller context — DB-backed
  // tool calls (myco_plans) read/write here, not tmpDir/myco.db.
  let groveDbPath: string;

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tool-cli-'));
    // The CLI (requestContextFromEnvironment) only yields a caller-supplied
    // tenancy for a Grove-bound project with MYCO_PROJECT_ID + MYCO_GROVE_ID
    // in env. createMycoTools now rejects synthesized (anchor-derived)
    // tenancy, so the test fixture mirrors the real post-Grove CLI contract:
    // a registered Grove project plus the matching caller env.
    const home = path.join(rootDir, 'home');
    const projectRoot = path.join(rootDir, 'project');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.stubEnv('MYCO_HOME', home);
    const grove = createGrove('Work', home);
    saveProjectManifest(vaultDir, {
      project: { id: CLI_PROJECT_ID, name: 'tool-cli-test' },
      grove: { binding_id: 'gbind-cli', slug: grove.slug, mode: 'local' },
    });
    registerProjectInGrove(grove.id, {
      projectId: CLI_PROJECT_ID,
      projectName: 'tool-cli-test',
      projectRoot,
      bindingId: 'gbind-cli',
    }, home);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, CLI_PROJECT_ID);
    vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
    vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');
    groveDbPath = resolveGroveDbPath(grove.id, home);
    fs.mkdirSync(path.dirname(groveDbPath), { recursive: true });
    tmpDir = vaultDir;
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
    try { fs.unlinkSync(resolveServiceDaemonStatePath()); } catch { /* gone */ }
    process.exitCode = 0;
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  afterAll(() => {
    teardownTestDb();
  });

  function outputJson<T>(): T {
    return JSON.parse(written.join('')) as T;
  }

  /**
   * Start the REAL LOCAL daemon `/mcp` surface (`createStreamableMcpHttpHandler`)
   * behind a bare loopback HTTP server, and point `daemon.json` at it —
   * `myco tool call`/`myco tool list` now speak MCP JSON-RPC to this, never
   * `createMycoTools` in-process (decision-14e572a3).
   */
  async function startLocalDaemon(): Promise<void> {
    const handler = createStreamableMcpHttpHandler(tmpDir, { client: mockDaemonClient(digestHeaders) });
    const server = http.createServer((req, res) => {
      // DaemonClient.ensureRunning()/isHealthy() probe this before the CLI
      // ever dials `/mcp` — a bare wrapper around the MCP handler alone
      // never resolves healthy, since the handler doesn't understand
      // `/health` (it treats every path as an MCP request).
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid }));
        return;
      }
      void handler(req, res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    const statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: address.port }), 'utf-8');
  }

  it('lists tools as JSON', async () => {
    await startLocalDaemon();
    await run(['list', '--json'], tmpDir);

    const output = outputJson<{ ok: boolean; result: Array<{ name: string }> }>();
    expect(output.ok).toBe(true);
    expect(output.result.map((tool) => tool.name)).toContain('myco_cortex');
  });

  it('calls a tool with inline JSON input', async () => {
    await startLocalDaemon();
    await run(['call', 'myco_cortex', '--json', '--input', '{"op":"digest","tier":5000}'], tmpDir);

    const output = outputJson<{ ok: boolean; tool: string; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_cortex');
    expect(output.result.tier).toBe(5000);
  });

  it('forwards explicit environment request context to daemon-backed tools', async () => {
    const home = path.join(rootDir, 'explicit-home');
    const projectRoot = path.join(rootDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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

    vi.stubEnv('MYCO_HOME', home);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectRoot, projectRoot);
    vi.stubEnv(REQUEST_CONTEXT_ENV.projectId, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    vi.stubEnv(REQUEST_CONTEXT_ENV.groveId, grove.id);
    vi.stubEnv(REQUEST_CONTEXT_ENV.machineId, 'machine-a');
    vi.stubEnv(REQUEST_CONTEXT_ENV.sessionId, 'sess-a');
    await startLocalDaemon();

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
    await startLocalDaemon();
    const inputPath = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(inputPath, '{"op":"digest","tier":1500}', 'utf-8');

    await run(['call', 'myco_cortex', '--json', '--input', `@${inputPath}`], tmpDir);

    const output = outputJson<{ ok: boolean; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.result.tier).toBe(1500);
  });

  it('calls a tool when options appear before the tool name', async () => {
    await startLocalDaemon();
    await run(['call', '--json', '--input', '{"op":"digest","tier":5000}', 'myco_cortex'], tmpDir);

    const output = outputJson<{ ok: boolean; tool: string; result: { tier: number } }>();
    expect(output.ok).toBe(true);
    expect(output.tool).toBe('myco_cortex');
    expect(output.result.tier).toBe(5000);
  });

  it('flushes large JSON tool output before returning', async () => {
    await startLocalDaemon();
    // The CLI resolves its DB from the caller context's Grove DB path, and
    // grove-bound reads filter by project_id — write the plan there with the
    // matching project scope so the read finds it.
    const db = openDatabase(groveDbPath);
    try {
      createSchema(db);
      withDatabase(db, () => {
        upsertPlan({
          id: 'large-plan',
          project_id: CLI_PROJECT_ID,
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

  it('returns invalid_input for non-object JSON input (checked client-side, before any daemon round-trip)', async () => {
    // No daemon started — the CLI must reject this before ever dialing the
    // daemon, exactly like the missing-value/invalid-JSON cases above. The
    // MCP `arguments` wire schema is a strict record; round-tripping a
    // non-object would surface as an opaque transport error, not this code.
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

  it('returns JSON error envelope for unknown tools (round-tripped through the daemon)', async () => {
    await startLocalDaemon();
    await run(['call', 'missing_tool', '--json', '--input', '{}'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('unknown_tool');
    expect(process.exitCode).toBe(1);
  });

  it('returns a clear, actionable error when the daemon is unavailable', async () => {
    // No daemon.json, no stub server, and MYCO_NO_AUTO_SPAWN=1 so
    // DaemonClient.ensureRunning() can't fork a real daemon process out from
    // under this test.
    vi.stubEnv('MYCO_NO_AUTO_SPAWN', '1');

    await run(['call', 'myco_cortex', '--json', '--input', '{"op":"digest"}'], tmpDir);

    const output = outputJson<{ ok: boolean; error: { code: string; message: string } }>();
    expect(output.ok).toBe(false);
    expect(output.error.code).toBe('daemon_unavailable');
    expect(output.error.message.length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(1);
  });

  it('never imports createMycoTools directly (decision-14e572a3: the CLI delegates to the daemon, permanently)', () => {
    const cliDir = path.resolve(__dirname, '..', '..', 'packages', 'myco', 'src', 'cli');
    const offenders: string[] = [];
    for (const name of fs.readdirSync(cliDir)) {
      if (!name.endsWith('.ts')) continue;
      const source = fs.readFileSync(path.join(cliDir, name), 'utf-8');
      if (/from\s+['"][^'"]*tools\/index\.js['"]/.test(source) || /import\(['"][^'"]*tools\/index\.js['"]\)/.test(source)) {
        offenders.push(name);
      }
    }
    expect(offenders, `cli/ files importing the in-process tools runtime: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('myco tool CLI — attached (Team Host) project', () => {
  const HOST_ID = 'host_0123456789abcdef0123456789abcdef';
  const GROVE_ID = 'grove_0123456789abcdef0123456789abcdef';
  const PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const HOST_BEARER = 'host-bearer-secret-for-cli-attached-test';

  let tmp: string;
  let vaultDir: string;
  let member: http.Server;
  let hostFixture: http.Server;
  let hostRequests: Array<{ method: string; body: string; headers: http.IncomingHttpHeaders }>;
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;
  let written: string[];
  let originalStdoutWrite: typeof process.stdout.write;

  /**
   * A protocol-correct fixture "host": a REAL MCP `Server` + a fresh
   * `StreamableHTTPServerTransport` per request (mirrors `mcp/http.ts`'s own
   * stateless-per-POST contract), so `initialize`/`notifications/initialized`/
   * `tools/call` all work exactly as they would against a real Myco host
   * daemon. Deliberately NOT a second `createStreamableMcpHttpHandler`
   * instance — that would read the SAME process-global `MYCO_TEAM_HOME`
   * attach registry as the member and re-classify its own inbound (already
   * proxied) request as remote too, proxying to itself forever.
   */
  function createHostFixture(): http.Server {
    return http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          hostRequests.push({ method: req.method ?? '', body, headers: req.headers });
          const mcpServer = new Server({ name: 'fixture-host', version: '1.0.0' }, { capabilities: { tools: {} } });
          mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => ({
            content: [{ type: 'text', text: JSON.stringify({ marker: 'FROM_HOST' }) }],
            structuredContent: { result: { marker: 'FROM_HOST', tool: request.params.name } },
          }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => { void transport.close(); void mcpServer.close(); });
          await mcpServer.connect(transport);
          const parsedBody = body.length > 0 ? JSON.parse(body) : undefined;
          await transport.handleRequest(req, res, parsedBody);
        })();
      });
    });
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tool-cli-attached-'));
    const teamHome = path.join(tmp, 'team-home');
    const mycoHome = path.join(tmp, 'home');
    const projectRoot = path.join(tmp, 'project');
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

    savedHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_TEAM_HOME = teamHome;

    // An attached project's local manifest carries ONLY a project id — never
    // a local Grove binding (the never-materialize invariant; the real
    // Grove/DB live on the host, not this checkout).
    saveProjectManifest(vaultDir, { project: { id: PROJECT_ID, name: 'attached-project' } });

    hostRequests = [];
    hostFixture = createHostFixture();
    const hostPort = await new Promise<number>((resolve) => {
      hostFixture.listen(0, '127.0.0.1', () => resolve((hostFixture.address() as { port: number }).port));
    });

    upsertHost({
      host_id: HOST_ID,
      label: 'Fixture Host',
      overlay_address: `127.0.0.1:${hostPort}`,
      protocol_version: 1,
      created_at: new Date().toISOString(),
      projects: [{ grove_id: GROVE_ID, project_id: PROJECT_ID, root: projectRoot }],
    });
    writeHostSecret(HOST_ID, HOST_BEARER_SECRET, HOST_BEARER);

    // The LOCAL daemon: the real `/mcp` handler. For an attached project
    // every request short-circuits to the host BEFORE `client` is ever
    // touched (mcp/http.ts's classifyRoute chokepoint), so a trivial mock
    // suffices.
    const localHandler = createStreamableMcpHttpHandler(vaultDir, { client: mockDaemonClient() });
    member = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ myco: true, pid: process.pid }));
        return;
      }
      void localHandler(req, res);
    });
    const memberPort = await new Promise<number>((resolve) => {
      member.listen(0, '127.0.0.1', () => resolve((member.address() as { port: number }).port));
    });
    const statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: memberPort }), 'utf-8');

    written = [];
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
    member.close();
    hostFixture.close();
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    try { fs.unlinkSync(resolveServiceDaemonStatePath()); } catch { /* gone */ }
    process.exitCode = 0;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function outputJson<T>(): T {
    return JSON.parse(written.join('')) as T;
  }

  it('an attached project\'s tool call returns HOST-grove data, not a (nonexistent) local vault read', async () => {
    await run(['call', 'myco_search', '--json', '--input', '{"query":"host probe"}'], vaultDir);

    const output = outputJson<{ ok: boolean; tool: string; result: { marker: string; tool: string } }>();
    expect(output.ok).toBe(true);
    expect(output.result.marker).toBe('FROM_HOST');
    expect(output.result.tool).toBe('myco_search');

    // The call actually crossed the wire to the fixture host — this project
    // has no local Grove/DB at all, so any non-host answer would mean the
    // CLI silently fell back to something else instead of routing there.
    const toolCalls = hostRequests.filter((r) => {
      try { return JSON.parse(r.body)?.method === 'tools/call'; } catch { return false; }
    });
    expect(toolCalls).toHaveLength(1);
    expect(JSON.parse(toolCalls[0].body).params.name).toBe('myco_search');
  });
});
