/**
 * Task 10: external read-only MCP — (tool, op) allowlist, dedicated
 * listener, token gate, Funnel toggle (server-mode design spec §7).
 *
 * Covers the brief's Step 1 (a)-(f) plus the two obligations carried from
 * Task 8's review:
 *   (a) allowlisted ops pass
 *   (b) excluded ops/tools -> tool-not-found-shaped refusal, indistinguishable
 *       from a nonexistent tool (the real handler is never reached)
 *   (c) no/bad token -> 401, including the constant-time-compare obligation
 *       (a wrong token AND a truncated token both 401, never a 500 — a bug in
 *       the hash-first design would surface as a crash on the length-mismatch
 *       branch, not a clean refusal)
 *   (d) the listener serves /mcp only — /health, /api/* -> 404
 *   (e) listener teardown makes the surface unreachable
 *   (f) persisted activation converges to confirmed Funnel-off at boot
 *
 * Fix Round 1 (server-mode spec §1 — groves are never external-facing) adds:
 * headerless requests succeed with grove-wide tenancy; a tool-call
 * `project_id` ARGUMENT (not a header) still selects a project; any
 * tenancy header naming something other than the served Grove — unknown,
 * real-but-foreign, or a project not registered in the served Grove — all
 * collapse into the SAME uniform 404 (no existence oracle).
 *
 * Real HTTP against the real listener (`ExternalMcpListener`), never a
 * hand-rolled request object — mirrors `tests/mcp/http.test.ts`'s pattern.
 */
import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  EXTERNAL_TOOL_ALLOWLIST,
  createExternalTools,
  isAllowedExternalCall,
} from '@myco/mcp/external-surface';
import {
  ExternalMcpListener,
  constantTimeTokenEqual,
  createFunnelOffRunner,
  createFunnelOnRunner,
  resolveExternalMcpSocketPath,
} from '@myco/daemon/external-listener';
import { ExternalMcpContainmentAuthority } from '@myco/daemon/external-mcp-containment';
import { ToolError } from '@myco/tools/error';
import type { MycoTools } from '@myco/tools/index';
import type { ToolDefinition } from '@myco/tools/definitions';
import { DaemonLogger } from '@myco/daemon/logger';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids';
import { createSecretsOperations } from '@myco/config/secrets';
import { loadMachineConfig, saveMachineConfig } from '@myco/config/loader';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '@myco/constants';
import type { HostServeRuntime } from '@myco/daemon/host-serve';
import type { DaemonClient } from '@myco/hooks/client';
import { vi } from '../helpers/vi-shim.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { seedExternalMcpConfig } from '../helpers/external-mcp-config-fixture.js';

const { writeSecret } = createSecretsOperations(testPerUserLockNamespace);

// ---------------------------------------------------------------------------
// (a)/(b) — pure allowlist unit tests (no HTTP, no daemon)
// ---------------------------------------------------------------------------

describe('EXTERNAL_TOOL_ALLOWLIST — verbatim per the plan brief', () => {
  it('is exactly the six read-only (tool, op) entries', () => {
    expect(Object.keys(EXTERNAL_TOOL_ALLOWLIST).sort()).toEqual([
      'myco_cortex', 'myco_plans', 'myco_search', 'myco_sessions', 'myco_skills', 'myco_spores',
    ]);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_search]).toEqual(['*']);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_cortex]).toEqual(['digest']);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_plans].sort()).toEqual(['get', 'list']);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_sessions].sort()).toEqual(['get', 'list']);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_skills].sort()).toEqual(['get', 'list']);
    expect([...EXTERNAL_TOOL_ALLOWLIST.myco_spores].sort()).toEqual(['get', 'list']);
  });

  it('myco_agent and every collective_* tool are absent entirely', () => {
    expect(EXTERNAL_TOOL_ALLOWLIST.myco_agent).toBeUndefined();
    expect(EXTERNAL_TOOL_ALLOWLIST.collective_search).toBeUndefined();
  });
});

describe('external MCP production activation posture', () => {
  test('production wiring exposes only exact-port Funnel-off containment', () => {
    const sourceRoot = path.join(process.cwd(), 'packages/myco/src/daemon');
    const listenerSource = fs.readFileSync(
      path.join(sourceRoot, 'external-listener.ts'),
      'utf-8',
    );
    const routeSource = fs.readFileSync(
      path.join(sourceRoot, 'api/team-config.ts'),
      'utf-8',
    );
    const mainSource = fs.readFileSync(path.join(sourceRoot, 'main.ts'), 'utf-8');

    expect(listenerSource).toContain("'status', '--json'");
    expect(listenerSource).toContain('`--set-path=${selector.mount}`');
    expect(listenerSource).not.toContain("String(port), 'off'");
    expect(listenerSource).not.toContain('defaultFunnelRunner');
    expect(routeSource).not.toContain('runFunnel');
    expect(routeSource).not.toContain('.bind(');
    const bootContainment = mainSource.indexOf(
      "return await externalMcpContainment.containWhile('reconcile'",
    );
    const routeRegistration = mainSource.indexOf('registerTeamConfigRoutes(');
    const databaseInitialization = mainSource.indexOf('const db = initDatabase(');
    const vectorInitialization = mainSource.indexOf('new SqliteVecVectorStore(');
    const machineIdentity = mainSource.indexOf('const machineId = getMachineId()');
    const secretsLoad = mainSource.indexOf('loadLayeredSecrets([');
    const mergedConfigLoad = mainSource.indexOf('const config = loadMergedConfig(');
    const manifestLoad = mainSource.indexOf('const manifests = loadManifests()');
    const groveAssertion = mainSource.indexOf('assertGroveBound(');
    const shutdownContainment = mainSource.indexOf(
      "externalMcpContainment.contain('shutdown')",
    );
    const recurringWorkStop = mainSource.indexOf('selfReconcileLoop.stop()');
    const serverStop = mainSource.indexOf('await server.stop()');
    expect(bootContainment).toBeGreaterThanOrEqual(0);
    expect(bootContainment).toBeLessThan(databaseInitialization);
    expect(bootContainment).toBeLessThan(vectorInitialization);
    expect(bootContainment).toBeLessThan(routeRegistration);
    expect(bootContainment).toBeLessThan(machineIdentity);
    expect(bootContainment).toBeLessThan(secretsLoad);
    expect(bootContainment).toBeLessThan(mergedConfigLoad);
    expect(bootContainment).toBeLessThan(manifestLoad);
    expect(bootContainment).toBeLessThan(groveAssertion);
    expect(shutdownContainment).toBeGreaterThanOrEqual(0);
    expect(shutdownContainment).toBeLessThan(recurringWorkStop);
    expect(shutdownContainment).toBeLessThan(serverStop);
    expect(mainSource)
      .toContain("await prepareShutdown('shutdown-request')");
    expect(mainSource)
      .toContain("return () => beginPreparedShutdown('shutdown-request')");
  });

  test('production runner removes the Myco handler and makes coexisting handlers private', async () => {
    let config: Record<string, unknown> = {
      TCP: { 443: { HTTPS: true } },
      Web: {
        'host.example.ts.net:443': {
          Handlers: {
            '/': { Proxy: 'http://127.0.0.1:8743' },
            '/docs': { Proxy: 'http://127.0.0.1:9999' },
          },
        },
      },
      AllowFunnel: { 'host.example.ts.net:443': true },
    };
    const calls: string[][] = [];
    const runner = createFunnelOffRunner(async (args) => {
      calls.push(args);
      if (args[1] === 'status') return { stdout: JSON.stringify(config) };
      if (args.at(-1) !== 'off') {
        expect(args).toEqual([
          'serve',
          '--bg',
          '--yes',
          '--https=443',
          '--set-path=/',
          'http://127.0.0.1:8743',
        ]);
        config = {
          ...config,
          AllowFunnel: {},
        };
      } else {
        expect(args).toEqual([
          'serve',
          '--bg',
          '--yes',
          '--https=443',
          '--set-path=/',
          'off',
        ]);
        config = {
          ...config,
          Web: {
            'host.example.ts.net:443': {
              Handlers: {
                '/docs': { Proxy: 'http://127.0.0.1:9999' },
              },
            },
          },
        };
      }
      return { stdout: '' };
    });

    await expect(runner({ kind: 'port', port: 8743 })).resolves.toEqual({
      ok: true,
      detail: 'confirmed no public Funnel handler targets local port 8743',
    });
    expect(calls).toEqual([
      ['funnel', 'status', '--json'],
      [
        'serve',
        '--bg',
        '--yes',
        '--https=443',
        '--set-path=/',
        'http://127.0.0.1:8743',
      ],
      ['serve', '--bg', '--yes', '--https=443', '--set-path=/', 'off'],
      ['funnel', 'status', '--json'],
    ]);
  });

  test('production runner clears AllowFunnel when Myco is the only handler', async () => {
    let config: Record<string, unknown> = {
      TCP: { 443: { HTTPS: true } },
      Web: {
        'host.example.ts.net:443': {
          Handlers: {
            '/mcp': { Proxy: 'http://127.0.0.1:8743' },
          },
        },
      },
      AllowFunnel: { 'host.example.ts.net:443': true },
    };
    const calls: string[][] = [];
    const runner = createFunnelOffRunner(async (args) => {
      calls.push(args);
      if (args[1] === 'status') return { stdout: JSON.stringify(config) };
      if (args.at(-1) !== 'off') {
        config = {
          ...config,
          AllowFunnel: {},
        };
      } else {
        config = {
          ...config,
          Web: {},
        };
      }
      return { stdout: '' };
    });

    await expect(runner({ kind: 'port', port: 8743 })).resolves.toEqual({
      ok: true,
      detail: 'confirmed no public Funnel handler targets local port 8743',
    });
    expect(calls).toEqual([
      ['funnel', 'status', '--json'],
      [
        'serve',
        '--bg',
        '--yes',
        '--https=443',
        '--set-path=/mcp',
        'http://127.0.0.1:8743',
      ],
      ['serve', '--bg', '--yes', '--https=443', '--set-path=/mcp', 'off'],
      ['funnel', 'status', '--json'],
    ]);
  });

  it('a missing vendor CLI (ENOENT) is verified-off, not a failure', async () => {
    const runner = createFunnelOffRunner(async () => {
      const err = new Error('spawn tailscale ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const result = await runner({ kind: 'port', port: 8743 });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('not installed');
  });

  it('any other runner failure stays fail-closed', async () => {
    const runner = createFunnelOffRunner(async () => {
      throw new Error('tailscale exited 1');
    });
    const result = await runner({ kind: 'port', port: 8743 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exited 1');
  });

  test('production runner leaves an unrelated replacement untouched', async () => {
    const calls: string[][] = [];
    const runner = createFunnelOffRunner(async (args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          TCP: { 443: { HTTPS: true } },
          Web: {
            'host.example.ts.net:443': {
              Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } },
            },
          },
          AllowFunnel: { 'host.example.ts.net:443': true },
        }),
      };
    });

    expect(await runner({ kind: 'port', port: 8743 })).toEqual({
      ok: true,
      detail: 'confirmed no public Funnel handler targets local port 8743',
    });
    expect(calls).toEqual([['funnel', 'status', '--json']]);
  });

  test('production runner requires verified post-state after an accepted off command', async () => {
    const status = JSON.stringify({
      TCP: { 443: { HTTPS: true } },
      Web: {
        'host.example.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:8743' } },
        },
      },
      AllowFunnel: { 'host.example.ts.net:443': true },
    });
    const runner = createFunnelOffRunner(async (args) => ({
      stdout: args[1] === 'status' ? status : '',
    }));

    const result = await runner({ kind: 'port', port: 8743 });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Funnel remains enabled');
  });
});

describe('isAllowedExternalCall', () => {
  it('(a) admits every allowlisted (tool, op), including the schema default when op is omitted', () => {
    expect(isAllowedExternalCall('myco_search', { query: 'x' })).toBe(true);
    expect(isAllowedExternalCall('myco_cortex', { op: 'digest' })).toBe(true);
    expect(isAllowedExternalCall('myco_cortex', {})).toBe(true); // default op is 'digest'
    expect(isAllowedExternalCall('myco_plans', { op: 'list' })).toBe(true);
    expect(isAllowedExternalCall('myco_plans', {})).toBe(true); // default op is 'list'
    expect(isAllowedExternalCall('myco_plans', { op: 'get', id: 'p1' })).toBe(true);
    expect(isAllowedExternalCall('myco_sessions', { op: 'list' })).toBe(true);
    expect(isAllowedExternalCall('myco_sessions', { op: 'get', id: 's1' })).toBe(true);
    expect(isAllowedExternalCall('myco_skills', { op: 'list' })).toBe(true);
    expect(isAllowedExternalCall('myco_skills', { op: 'get', id: 'k1' })).toBe(true);
    expect(isAllowedExternalCall('myco_spores', { op: 'list' })).toBe(true);
    expect(isAllowedExternalCall('myco_spores', { op: 'get', id: 'sp1' })).toBe(true);
  });

  it('(b) refuses every write / operator op, and myco_cortex ops other than digest', () => {
    expect(isAllowedExternalCall('myco_spores', { op: 'save', content: 'x', type: 'decision' })).toBe(false);
    expect(isAllowedExternalCall('myco_spores', { op: 'supersede' })).toBe(false);
    expect(isAllowedExternalCall('myco_spores', { op: 'consolidate' })).toBe(false);
    expect(isAllowedExternalCall('myco_spores', { op: 'obsolete' })).toBe(false);
    expect(isAllowedExternalCall('myco_plans', { op: 'delete', id: 'p1' })).toBe(false);
    expect(isAllowedExternalCall('myco_plans', { op: 'save', content: 'x' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'maintenance_summary' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'projects_activity' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'instructions' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'canopy_map' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'canopy_entry' })).toBe(false);
    expect(isAllowedExternalCall('myco_cortex', { op: 'notifications' })).toBe(false);
  });

  it('refuses tools entirely absent from the surface (myco_agent, collective_*)', () => {
    expect(isAllowedExternalCall('myco_agent', { op: 'runs' })).toBe(false);
    expect(isAllowedExternalCall('collective_search', { query: 'x' })).toBe(false);
  });
});

function fakeMycoTools(): MycoTools & { calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const ALL_DEFS = [
    'myco_search', 'myco_cortex', 'myco_plans', 'myco_sessions', 'myco_skills', 'myco_spores', 'myco_agent',
  ].map((name): ToolDefinition => ({
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
  }));
  return {
    calls,
    async listTools() { return ALL_DEFS; },
    getRegisteredTools() { return ALL_DEFS.map((d) => d.name); },
    async callTool(name: string, args?: unknown) {
      calls.push({ name, args });
      // Mirror the real dispatcher's behavior for a genuinely unknown name —
      // the SAME shape `createExternalTools` must produce for an allowlist miss.
      if (!ALL_DEFS.some((d) => d.name === name)) {
        throw new ToolError('unknown_tool', `Unknown tool: ${name}`);
      }
      return { ok: true, name, args };
    },
  };
}

describe('createExternalTools — the wrapper the listener dispatches through', () => {
  it('(a) listTools() narrows the catalog to the six allowlisted tool names only', async () => {
    const external = createExternalTools(fakeMycoTools());
    const names = (await external.listTools()).map((t) => t.name);
    expect(names.sort()).toEqual(['myco_cortex', 'myco_plans', 'myco_search', 'myco_sessions', 'myco_skills', 'myco_spores']);
    expect(names).not.toContain('myco_agent');
  });

  it('(a) delegates an allowlisted call to the real handler unchanged', async () => {
    const inner = fakeMycoTools();
    const external = createExternalTools(inner);
    const result = await external.callTool('myco_plans', { op: 'list' });
    expect(result).toEqual({ ok: true, name: 'myco_plans', args: { op: 'list' } });
    expect(inner.calls).toEqual([{ name: 'myco_plans', args: { op: 'list' } }]);
  });

  it('(b) a disallowed op is byte-identical, code-and-message, to a genuinely nonexistent tool — and the real handler is NEVER invoked', async () => {
    const inner = fakeMycoTools();
    const external = createExternalTools(inner);

    let disallowed: ToolError | undefined;
    try {
      await external.callTool('myco_spores', { op: 'save', content: 'x', type: 'decision' });
    } catch (err) {
      disallowed = err as ToolError;
    }
    expect(disallowed).toBeInstanceOf(ToolError);
    expect(disallowed?.code).toBe('unknown_tool');
    expect(disallowed?.message).toBe('Unknown tool: myco_spores');
    // The real spores handler was never reached — the refusal happens at
    // the allowlist boundary, before dispatch.
    expect(inner.calls).toEqual([]);

    let nonexistent: ToolError | undefined;
    try {
      await external.callTool('myco_totally_fake_tool', {});
    } catch (err) {
      nonexistent = err as ToolError;
    }
    expect(nonexistent).toBeInstanceOf(ToolError);
    expect(nonexistent?.code).toBe('unknown_tool');
    expect(nonexistent?.message).toBe('Unknown tool: myco_totally_fake_tool');

    // Same code, same message template — the allowlist-miss refusal is
    // structurally identical to the not-a-real-tool refusal.
    expect(disallowed?.code).toBe(nonexistent?.code);
    expect(disallowed?.message.startsWith('Unknown tool: ')).toBe(nonexistent?.message.startsWith('Unknown tool: '));
  });

  it('(b) myco_agent (absent from the allowlist entirely) refuses the same way', async () => {
    const inner = fakeMycoTools();
    const external = createExternalTools(inner);
    await expect(external.callTool('myco_agent', { op: 'runs' })).rejects.toMatchObject({ code: 'unknown_tool' });
    expect(inner.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// constant-time token compare (Task 8 review obligation #1)
// ---------------------------------------------------------------------------

describe('constantTimeTokenEqual', () => {
  it('true for an exact match', () => {
    expect(constantTimeTokenEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  it('false for a same-length wrong token', () => {
    expect(constantTimeTokenEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
  });

  it('false (never throws) for a truncated / shorter-length token', () => {
    const full = 'a'.repeat(64);
    const truncated = full.slice(0, 10);
    expect(() => constantTimeTokenEqual(truncated, full)).not.toThrow();
    expect(constantTimeTokenEqual(truncated, full)).toBe(false);
  });

  it('false (never throws) for a longer, prefix-matching presented value', () => {
    const expected = 'a'.repeat(32);
    const presented = expected + 'extra-garbage';
    expect(() => constantTimeTokenEqual(presented, expected)).not.toThrow();
    expect(constantTimeTokenEqual(presented, expected)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real listener, real HTTP — (a)-(f) end to end
// ---------------------------------------------------------------------------

interface CapturedGet { endpoint: string; options?: { headers?: Record<string, string> } }

function mockDaemonClient(capturedGets: CapturedGet[] = []): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string, options?: { headers?: Record<string, string> }) => {
      capturedGets.push({ endpoint, options });
      if (endpoint === '/api/digest') {
        return { ok: true, data: { tiers: [{ tier: 5000, content: 'external digest', generated_at: 1 }] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('ExternalMcpListener — real HTTP against the real listener', () => {
  let tmp: string;
  let vaultDir: string;
  let mycoHome: string;
  let grove: GroveRecord;
  let projectId: string;
  let projectRoot: string;
  let savedHome: string | undefined;
  let listener: ExternalMcpListener;
  const TOKEN = 'a'.repeat(64);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-external-mcp-'));
    savedHome = process.env.MYCO_HOME;
    mycoHome = path.join(tmp, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    process.env.MYCO_HOME = mycoHome;
    clearGroveRegistryCaches();

    vaultDir = path.join(tmp, 'anchor', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });

    grove = createGrove('Served', mycoHome);
    projectId = assertGroveProjectId(createProjectId());
    projectRoot = path.join(tmp, 'served-project');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, { projectId, projectName: 'Served project', projectRoot }, mycoHome);

    writeSecret(mycoHome, HOST_EXTERNAL_MCP_TOKEN_SECRET, TOKEN);
  });

  afterEach(async () => {
    await listener?.unbind();
    if (savedHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedHome;
    clearGroveRegistryCaches();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function hostServe(): HostServeRuntime {
    return { overlayAddress: '127.0.0.1', bearer: 'unused-here', servedGroveId: grove.id };
  }

  function newListener(capturedGets: CapturedGet[] = []): ExternalMcpListener {
    return new ExternalMcpListener({
      vaultDir,
      hostServe: hostServe(),
      client: mockDaemonClient(capturedGets),
      logger: new DaemonLogger(path.join(tmp, 'logs')) as never,
    });
  }

  function scopedHeaders(): Record<string, string> {
    return { 'x-myco-grove-id': grove.id, 'x-myco-project-id': projectId };
  }

  test('bind() never throws, even when the underlying http.Server#listen() throws synchronously (Fix Round 1)', async () => {
    // Node's http.Server#listen CAN throw synchronously (never emits
    // 'error') for some invalid inputs — e.g. RangeError for a port
    // outside 0-65535. bind()'s docstring promises "never throws": every
    // caller (the toggle route, boot re-bind) awaits it expecting a
    // resolved `{ ok: false }` on failure, never a rejected promise. Force
    // that exact shape by making `http.createServer()`'s returned server
    // throw from `.listen()`, since the real port-range values that trigger
    // this in Node aren't reliably reproducible across every http
    // implementation the test suite runs under.
    listener = newListener();
    const originalCreateServer = http.createServer;
    const patchedCreateServer = ((...args: Parameters<typeof http.createServer>) => {
      const server = originalCreateServer(...args);
      server.listen = () => { throw new RangeError('synthetic synchronous listen failure'); };
      return server;
    }) as typeof http.createServer;
    (http as { createServer: typeof http.createServer }).createServer = patchedCreateServer;
    try {
      const result = await listener.bind({ kind: 'loopback', port: 12345 });
      expect(result.ok).toBe(false);
    } finally {
      (http as { createServer: typeof http.createServer }).createServer = originalCreateServer;
    }
    expect(listener.isBound).toBe(false);
  });

  test('(d) serves /mcp only — /health and /api/* are 404, indistinguishable from any other unregistered path', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const base = `http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}`;

    for (const p of ['/health', '/api/version', '/api/team/config', '/', '/mcp-not-quite']) {
      const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status, `${p} should be 404`).toBe(404);
    }
  });

  test('(c) no token -> 401', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(c) wrong token (same length) -> 401', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'b'.repeat(64)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(c) truncated token -> 401, never a 500 (the constant-time-compare obligation, exercised over real HTTP)', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN.slice(0, 8)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(a) lists only the allowlisted tools and calls an allowlisted op end to end', async () => {
    const capturedGets: CapturedGet[] = [];
    listener = newListener(capturedGets);
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`);

    const client = new Client({ name: 'external-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...scopedHeaders() } },
    });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual(['myco_cortex', 'myco_plans', 'myco_search', 'myco_sessions', 'myco_skills', 'myco_spores']);

    const digest = await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });
    expect(digest.content[0]).toEqual({ type: 'text', text: 'external digest' });
    expect(capturedGets.some((c) => c.endpoint === '/api/digest')).toBe(true);

    const plans = await client.callTool({ name: 'myco_plans', arguments: { op: 'list' } });
    expect(plans.isError).not.toBe(true);

    await client.close();
  });

  test('(b) myco_spores op:save, myco_plans op:delete, myco_cortex op:maintenance_summary all refuse tool-not-found-shaped', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`);
    const client = new Client({ name: 'external-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...scopedHeaders() } },
    });
    await client.connect(transport);

    const disallowedCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'myco_spores', arguments: { op: 'save', content: 'x', type: 'decision' } },
      { name: 'myco_plans', arguments: { op: 'delete', id: 'p1' } },
      { name: 'myco_cortex', arguments: { op: 'maintenance_summary' } },
    ];
    const fakeToolCall = { name: 'myco_totally_fake_tool', arguments: {} };

    const errors: string[] = [];
    for (const call of [...disallowedCalls, fakeToolCall]) {
      try {
        await client.callTool(call);
        errors.push('DID NOT THROW');
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    // Every disallowed call AND the genuinely nonexistent tool surface the
    // same "Unknown tool" shape from the MCP client's perspective.
    for (const message of errors) {
      expect(message).not.toBe('DID NOT THROW');
      expect(message).toContain('Unknown tool');
    }

    await client.close();
  });

  test('(e) toggle-off -> unbind makes the listener unreachable (connection refused)', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const port = (bound.target.kind === 'loopback' ? bound.target.port : 0);
    expect(listener.isBound).toBe(true);

    await listener.unbind();
    expect(listener.isBound).toBe(false);

    await expect(fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).rejects.toBeTruthy();
  });

  test('(f) boot containment turns a persisted activation off without binding a fresh listener', async () => {
    const firstListener = newListener();
    const firstBind = await firstListener.bind({ kind: 'loopback', port: 0 });
    if (!firstBind.ok) throw new Error('bind failed');
    const boundPort = firstBind.target.kind === 'loopback' ? firstBind.target.port : 0;
    seedExternalMcpConfig(mycoHome, { enabled: true, port: boundPort });
    await firstListener.unbind();

    listener = newListener();
    const offPorts: number[] = [];
    const containment = new ExternalMcpContainmentAuthority({
      mycoHome,
      stateDir: path.join(mycoHome, 'service'),
      listener,
      runFunnelOff: async (target) => {
        offPorts.push(target.kind === 'port' ? target.port : target.path);
        return { ok: true, detail: `off ${String(target.kind === 'port' ? target.port : target.path)}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });
    fs.mkdirSync(path.join(mycoHome, 'service'), { recursive: true });

    await containment.contain('retire');

    expect(offPorts).toEqual([boundPort]);
    expect(listener.isBound).toBe(false);
    expect(loadMachineConfig(mycoHome).daemon.external_mcp)
      .toEqual({ enabled: false, port: boundPort });
    await expect(fetch(`http://127.0.0.1:${boundPort}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...scopedHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).rejects.toBeTruthy();
  });

  describe('createFunnelOnRunner — real runner against a fake vendor CLI', () => {
    const SOCK = '/tmp/myco-emcp-on-test.sock';
    const statusWith = (proxy: string, opts: { https?: boolean; mount?: string; hostPort?: string } = {}) => JSON.stringify({
      AllowFunnel: { [opts.hostPort ?? 'host.tail1234.ts.net:443']: true },
      Web: { [opts.hostPort ?? 'host.tail1234.ts.net:443']: { Handlers: { [opts.mount ?? '/mcp']: { Proxy: proxy } } } },
      TCP: { [(opts.hostPort ?? 'host.tail1234.ts.net:443').split(':')[1]!]: { HTTPS: opts.https ?? true } },
    });
    const emptyStatus = JSON.stringify({ AllowFunnel: {}, Web: {}, TCP: {} });

    function runner(responses: string[], calls: string[][]) {
      let statusIndex = 0;
      return createFunnelOnRunner(async (args) => {
        calls.push(args);
        if (args[0] === 'funnel' && args[1] === 'status') {
          const body = responses[Math.min(statusIndex, responses.length - 1)]!;
          statusIndex += 1;
          return { stdout: body };
        }
        return { stdout: '' };
      });
    }

    it('activates when no handler exists and derives the funnel URL from the selector host-port', async () => {
      const calls: string[][] = [];
      const result = await runner([emptyStatus, statusWith(`unix:${SOCK}`)], calls)(
        { kind: 'socket', path: SOCK },
        { mount: '/mcp', publicPort: 443 },
      );
      expect(result).toEqual({
        ok: true,
        detail: 'public Funnel serves host.tail1234.ts.net:443/mcp',
        funnelUrl: 'https://host.tail1234.ts.net/mcp',
      });
      expect(calls.map((args) => args[0])).toEqual(['funnel', 'funnel', 'funnel']);
      expect(calls[1]).toEqual(['funnel', '--bg', '--yes', '--https=443', '--set-path=/mcp', `unix:${SOCK}`]);
    });

    it('is IDEMPOTENT: an already-serving handler causes no mutation at all', async () => {
      const calls: string[][] = [];
      const result = await runner([statusWith(`unix:${SOCK}`)], calls)(
        { kind: 'socket', path: SOCK },
        { mount: '/mcp', publicPort: 443 },
      );
      expect(result.ok).toBe(true);
      // status, status — never a mutating invocation.
      expect(calls.every((args) => args[1] === 'status')).toBe(true);
    });

    it('repairs drift: a handler at the mount proxying a DIFFERENT socket is re-pointed', async () => {
      const calls: string[][] = [];
      const result = await runner(
        [statusWith('unix:/tmp/other.sock'), statusWith(`unix:${SOCK}`)],
        calls,
      )({ kind: 'socket', path: SOCK }, { mount: '/mcp', publicPort: 443 });
      expect(result.ok).toBe(true);
      expect(calls.some((args) => args.includes(`unix:${SOCK}`))).toBe(true);
    });

    it('fails CLOSED when the handler never appears after activation', async () => {
      const result = await runner([emptyStatus, emptyStatus], [])(
        { kind: 'socket', path: SOCK },
        { mount: '/mcp', publicPort: 443 },
      );
      expect(result).toEqual({ ok: false, detail: 'the Funnel handler did not verify after activation' });
    });

    it('reports a vendor-CLI failure as ok:false (never throws)', async () => {
      const failing = createFunnelOnRunner(async () => {
        throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
      });
      const result = await failing({ kind: 'socket', path: SOCK }, { mount: '/mcp', publicPort: 443 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toContain('ENOENT');
    });

    it("ignores an operator's UNRELATED Funnel entirely (foreign non-HTTPS forward must not block activation)", async () => {
      const foreignPlusOurs = JSON.stringify({
        AllowFunnel: { 'host.tail1234.ts.net:8443': true, 'host.tail1234.ts.net:443': true },
        Web: {
          'host.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } },
          'host.tail1234.ts.net:443': { Handlers: { '/mcp': { Proxy: `unix:${SOCK}` } } },
        },
        TCP: { 8443: { HTTPS: false }, 443: { HTTPS: true } },
      });
      const calls: string[][] = [];
      const result = await runner([foreignPlusOurs], calls)(
        { kind: 'socket', path: SOCK },
        { mount: '/mcp', publicPort: 443 },
      );
      expect(result.ok).toBe(true);
      expect(calls.every((args) => args[1] === 'status')).toBe(true);
    });
  });

  test('socket path derivation: deterministic, MYCO_HOME-distinct, sun_path-guarded', () => {
    const a = resolveExternalMcpSocketPath('/Users/x/.myco');
    const b = resolveExternalMcpSocketPath('/Users/x/.myco-dev');
    expect(a).toBe(resolveExternalMcpSocketPath('/Users/x/.myco'));
    // A dev daemon and the prod daemon must never contend for one socket.
    expect(a).not.toBe(b);
    expect(Buffer.byteLength(a)).toBeLessThan(100);
    expect(path.basename(path.dirname(a))).toBe('.myco-emcp');
  });

  test.skipIf(process.platform === 'win32')('(g) socket bind: serves /mcp over AF_UNIX, 0600 socket in 0700 dir', async () => {
    listener = newListener();
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-emcp-test-'));
    const sockPath = path.join(sockDir, 'emcp.sock');
    const bound = await listener.bind({ kind: 'socket', path: sockPath });
    if (!bound.ok) throw new Error(`socket bind failed: ${bound.error}`);
    expect(bound.target).toEqual({ kind: 'socket', path: sockPath });
    expect(listener.boundTarget).toEqual({ kind: 'socket', path: sockPath });
    expect(fs.statSync(sockPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(sockPath)).mode & 0o777).toBe(0o700);

    // curl-over-unix-socket equivalent: raw HTTP over the socket.
    const responseText = await new Promise<string>((resolve, reject) => {
      const client = net.connect(sockPath, () => {
        client.write('POST /nope HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n');
      });
      let data = '';
      client.on('data', (chunk) => { data += String(chunk); });
      client.on('end', () => resolve(data));
      client.on('error', reject);
      setTimeout(() => { client.destroy(); resolve(data); }, 3000);
    });
    expect(responseText).toContain('404');
    expect(responseText).toContain('not_found');

    await listener.unbind();
    expect(fs.existsSync(sockPath)).toBe(false);
    fs.rmSync(sockDir, { recursive: true, force: true });
  });

  test.skipIf(process.platform === 'win32')('(h) socket bind reclaims a STALE socket file but refuses a LIVE one', async () => {
    const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-emcp-test-'));
    const sockPath = path.join(sockDir, 'emcp.sock');

    // Stale: a socket file with no owner (simulates SIGKILL residue).
    const stale = net.createServer();
    await new Promise<void>((resolve) => stale.listen(sockPath, resolve));
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    fs.writeFileSync(sockPath, ''); // close() unlinks; recreate the dead inode
    listener = newListener();
    const reclaimed = await listener.bind({ kind: 'socket', path: sockPath });
    expect(reclaimed.ok).toBe(true);
    await listener.unbind();

    // Live: another server owns the socket — bind must refuse, not unlink.
    const owner = net.createServer(() => {});
    await new Promise<void>((resolve) => owner.listen(sockPath, resolve));
    const refused = await listener.bind({ kind: 'socket', path: sockPath });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain('live owner');
    expect(fs.existsSync(sockPath)).toBe(true);
    await new Promise<void>((resolve) => owner.close(() => resolve()));
    fs.rmSync(sockDir, { recursive: true, force: true });
  });

  test('a rotated token invalidates the previous one on the very next request (no restart needed)', async () => {
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const base = `http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}`;

    const before = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...scopedHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(before.status).toBe(200);

    const rotated = 'c'.repeat(64);
    writeSecret(mycoHome, HOST_EXTERNAL_MCP_TOKEN_SECRET, rotated);

    const withOldToken = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, ...scopedHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(withOldToken.status).toBe(401);

    const withNewToken = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${rotated}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...scopedHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(withNewToken.status).toBe(200);
  });

  test('wrong Grove headers (a Grove that is not the served one) refuse — never leaks another Grove on this host', async () => {
    const otherGrove = createGrove('Other', mycoHome);
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-myco-grove-id': otherGrove.id,
        'x-myco-project-id': projectId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  test('a body grove_id outside the served Grove is refused without revealing the target', async () => {
    const other = createGrove('Other', mycoHome);
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`);
    const client = new Client({ name: 'external-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...scopedHeaders() } },
    });
    await client.connect(transport);

    let message = 'DID NOT THROW';
    try {
      await client.callTool({
        name: 'myco_plans',
        arguments: { op: 'list', grove_id: other.id },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('DID NOT THROW');
    expect(message).toContain(
      "Requested Grove is outside this tool surface's authorized scope",
    );
    expect(message).not.toContain(other.id);

    const plans = await client.callTool({
      name: 'myco_plans',
      arguments: { op: 'list', grove_id: grove.id },
    });
    expect(plans.isError).not.toBe(true);

    await client.close();
  });

  test('no headers at all -> 200: tenancy defaults to the served Grove (server-mode spec §1, Fix Round 1)', async () => {
    // Groves are never external-facing: a caller with no
    // x-myco-grove-id/x-myco-project-id headers at all still dispatches
    // successfully. tools/list still shows exactly the six allowlisted
    // tools, and an allowlisted call succeeds end to end.
    const capturedGets: CapturedGet[] = [];
    listener = newListener(capturedGets);
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`);

    const client = new Client({ name: 'external-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'myco_cortex', 'myco_plans', 'myco_search', 'myco_sessions', 'myco_skills', 'myco_spores',
    ]);

    const digest = await client.callTool({ name: 'myco_cortex', arguments: { op: 'digest', tier: 5000 } });
    expect(digest.content[0]).toEqual({ type: 'text', text: 'external digest' });

    // The served Grove was resolved WITHOUT a caller-supplied grove_id — the
    // internal loopback call (`/api/digest`) carries the derived grove_id
    // but no project_id (grove-wide, not any one project).
    const digestCall = capturedGets.find((c) => c.endpoint === '/api/digest');
    expect(digestCall?.options?.headers?.['x-myco-grove-id']).toBe(grove.id);
    expect(digestCall?.options?.headers?.['x-myco-project-id']).toBeUndefined();

    // myco_plans list dispatches in-process against the served Grove's own
    // DB (grove-wide scope) — no error, even with zero plans saved.
    const plans = await client.callTool({ name: 'myco_plans', arguments: { op: 'list' } });
    expect(plans.isError).not.toBe(true);

    await client.close();
  });

  test('no grove_id header, but a tool-call project_id ARGUMENT -> pivots to that project (mirrors the worker contract)', async () => {
    // The worker's contract: project_id is a per-CALL selector, not a
    // transport-level header requirement. The same `project_id` tool
    // argument every allowlisted tool already accepts (`tools/
    // call-context.ts`'s scope pivot) works with zero tenancy headers.
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`);
    const client = new Client({ name: 'external-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);

    const plans = await client.callTool({ name: 'myco_plans', arguments: { op: 'list', project_id: projectId } });
    expect(plans.isError).not.toBe(true);

    await client.close();
  });

  test('an x-myco-project-id header naming a project NOT registered in the served Grove -> the SAME uniform 404', async () => {
    const foreignProjectId = assertGroveProjectId(createProjectId());
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-myco-grove-id': grove.id,
        'x-myco-project-id': foreignProjectId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const payload = await res.json() as { error?: string };
    expect(payload.error).toBe('not_found');
  });

  test('a genuinely unknown x-myco-grove-id -> the SAME uniform 404 as a real-but-foreign grove_id (no existence oracle)', async () => {
    const otherGrove = createGrove('Other', mycoHome);
    listener = newListener();
    const bound = await listener.bind({ kind: 'loopback', port: 0 });
    if (!bound.ok) throw new Error('bind failed');
    const base = `http://127.0.0.1:${(bound.target.kind === 'loopback' ? bound.target.port : 0)}`;

    const unknownRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-myco-grove-id': 'grove_deadbeefdeadbeefdeadbeefdeadbeef' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const unknownBody = await unknownRes.json() as { error?: string };

    const knownButUnservedRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-myco-grove-id': otherGrove.id },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const knownButUnservedBody = await knownButUnservedRes.json() as { error?: string };

    expect(unknownRes.status).toBe(404);
    expect(knownButUnservedRes.status).toBe(404);
    expect(unknownBody.error).toBe(knownButUnservedBody.error);
  });
});
