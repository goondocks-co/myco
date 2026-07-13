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
 *   (e) toggle-off state -> listener unbound (connection refused)
 *   (f) restart with the toggle already on -> re-binds
 *
 * Real HTTP against the real listener (`ExternalMcpListener`), never a
 * hand-rolled request object — mirrors `tests/mcp/http.test.ts`'s pattern.
 */
import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  EXTERNAL_TOOL_ALLOWLIST,
  createExternalTools,
  isAllowedExternalCall,
} from '@myco/mcp/external-surface';
import { ExternalMcpListener, constantTimeTokenEqual } from '@myco/daemon/external-listener';
import { ToolError } from '@myco/tools/error';
import type { MycoTools } from '@myco/tools/index';
import type { ToolDefinition } from '@myco/tools/definitions';
import { DaemonLogger } from '@myco/daemon/logger';
import { createGrove, registerProjectInGrove, clearGroveRegistryCaches, type GroveRecord } from '@myco/grove/registry';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids';
import { writeSecret } from '@myco/config/secrets';
import { loadMachineConfig, saveMachineConfig } from '@myco/config/loader';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '@myco/constants';
import type { HostServeRuntime } from '@myco/daemon/host-serve';
import type { DaemonClient } from '@myco/hooks/client';
import { vi } from '../helpers/vi-shim.js';

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

  test('(d) serves /mcp only — /health and /api/* are 404, indistinguishable from any other unregistered path', async () => {
    listener = newListener();
    const bound = await listener.bind(0);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const base = `http://127.0.0.1:${bound.port}`;

    for (const p of ['/health', '/api/version', '/api/team/config', '/', '/mcp-not-quite']) {
      const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      expect(res.status, `${p} should be 404`).toBe(404);
    }
  });

  test('(c) no token -> 401', async () => {
    listener = newListener();
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(c) wrong token (same length) -> 401', async () => {
    listener = newListener();
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${'b'.repeat(64)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(c) truncated token -> 401, never a 500 (the constant-time-compare obligation, exercised over real HTTP)', async () => {
    listener = newListener();
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN.slice(0, 8)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  test('(a) lists only the allowlisted tools and calls an allowlisted op end to end', async () => {
    const capturedGets: CapturedGet[] = [];
    listener = newListener(capturedGets);
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${bound.port}/mcp`);

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
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const url = new URL(`http://127.0.0.1:${bound.port}/mcp`);
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
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const port = bound.port;
    expect(listener.isBound).toBe(true);

    await listener.unbind();
    expect(listener.isBound).toBe(false);

    await expect(fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })).rejects.toBeTruthy();
  });

  test('(f) restart with the toggle already on: a FRESH listener instance re-binds from persisted config', async () => {
    // Simulate the enable side of the toggle route: persist enabled:true +
    // a concrete port to machine config (the same write `handlePutExternalMcpToggle`
    // performs), then bind + shut down (process exit).
    const machine = loadMachineConfig(mycoHome);
    const firstListener = newListener();
    const firstBind = await firstListener.bind(0);
    if (!firstBind.ok) throw new Error('bind failed');
    const boundPort = firstBind.port;
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, external_mcp: { enabled: true, port: boundPort } },
    }, mycoHome);
    await firstListener.unbind();

    // "Restart": a brand-new listener instance reads the SAME persisted
    // config `daemon/main.ts`'s boot path reads, and re-binds on the SAME
    // port — exactly the re-bind-before-Funnel-traffic contract.
    const reloaded = loadMachineConfig(mycoHome).daemon.external_mcp;
    expect(reloaded.enabled).toBe(true);
    expect(reloaded.port).toBe(boundPort);

    listener = newListener();
    const secondBind = await listener.bind(reloaded.port);
    expect(secondBind.ok).toBe(true);
    if (!secondBind.ok) return;
    expect(secondBind.port).toBe(boundPort);

    const res = await fetch(`http://127.0.0.1:${boundPort}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...scopedHeaders() },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });

  test('a rotated token invalidates the previous one on the very next request (no restart needed)', async () => {
    listener = newListener();
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const base = `http://127.0.0.1:${bound.port}`;

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
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${bound.port}/mcp`, {
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

  test('no headers at all (no caller tenancy) -> 404 not_found, never a silent anchor default', async () => {
    // Headerless resolves to no Grove at all (the fallback vault carries no
    // project.toml), so the served-grove filter's null-grove branch refuses
    // BEFORE any caller-tenancy question is reached — the same uniform 404
    // shape an overlay caller with no resolved Grove gets (`host-serve.ts`'s
    // `servedGroveRefusal`), never the anchor-vault-path-disclosing
    // `legacy_vault` 503 the loopback `/mcp` uses for a local caller.
    listener = newListener();
    const bound = await listener.bind(0);
    if (!bound.ok) throw new Error('bind failed');
    const res = await fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const payload = await res.json() as { error?: string };
    expect(payload.error).toBe('not_found');
  });
});
