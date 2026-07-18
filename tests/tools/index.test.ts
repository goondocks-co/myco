import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { createMycoTools } from '@myco/tools/index.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import { assertGroveProjectId, createProjectId } from '@myco/grove/ids.js';
import { resolveDaemonLogDir } from '@myco/daemon/service-state.js';
import type { DaemonClient } from '@myco/hooks/client.js';

const FIXTURE_VAULT = '/tmp/myco-vault';
const FIXTURE_PROJECT_ID = assertGroveProjectId(createProjectId());
const FIXTURE_CONTEXT = resolveLegacyRequestContext(FIXTURE_VAULT, {
  projectId: FIXTURE_PROJECT_ID,
  machineId: 'test-machine',
  // Legitimate transports (CLI env, MCP headers) hand createMycoTools a
  // caller-supplied context; the runtime now rejects absent/synthesized
  // tenancy, so the fixture mirrors the real caller case.
  tenancySource: 'caller',
});

function mockClient(options?: { digest?: unknown }): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
      if (endpoint === '/api/digest') {
        return { ok: true, data: options?.digest ?? { tiers: [] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('Myco tools dispatcher', () => {
  it('lists the core tool surface', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });
    const names = (await tools.listTools()).map((tool) => tool.name);

    expect(names).toContain('myco_cortex');
    expect(names).toContain('myco_spores');
  });

  it('dispatches a core tool through the shared path', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient({
      digest: {
        tiers: [{ tier: 5000, content: 'digest', generated_at: 1 }],
      },
    }), { requestContext: FIXTURE_CONTEXT });

    const result = await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 });

    expect(result).toEqual({
      content: 'digest',
      tier: 5000,
      fallback: false,
      generated_at: 1,
    });
  });

  it('rejects unknown tools', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('missing_tool', {})).rejects.toThrow('Unknown tool: missing_tool');
    // collective_* names are not registered tools; they fail the same way
    // as any other unknown tool name.
    await expect(tools.callTool('collective_search', { query: 'q' })).rejects.toThrow('Unknown tool: collective_search');
  });

  it('rejects non-object input', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('myco_cortex', 'bad')).rejects.toThrow('Tool arguments must be a JSON object');
  });

  it('validates required schema fields before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('myco_search', {})).rejects.toThrow("Missing required argument 'query'");
  });

  it('validates schema property types before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('myco_search', { query: 7 })).rejects.toThrow("Invalid argument 'query'");
  });

  it('validates schema enum values before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('myco_cortex', { op: 'digest', tier: 1234 })).rejects.toThrow("Invalid argument 'tier'");
  });

  it('validates array item types before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient(), { requestContext: FIXTURE_CONTEXT });

    await expect(tools.callTool('myco_spores', {
      op: 'save',
      content: 'note',
      type: 'gotcha',
      tags: ['ok', 7],
    })).rejects.toThrow("Invalid argument 'tags[1]'");
  });

  describe('logActivity per-tool summary fields', () => {
    // Each entry locks in the per-tool log shape contract that downstream
    // dashboards consume. Adding/removing summary fields here is a public
    // API change.
    async function readLastLog(vaultDir: string): Promise<Record<string, unknown>> {
      // logActivity uses fs.appendFile (callback-style, no promise to await).
      // Poll until the file appears rather than guessing a fixed delay.
      const logDir = resolveDaemonLogDir(vaultDir, { env: process.env });
      const file = path.join(logDir, 'mcp.jsonl');
      for (let i = 0; i < 50; i++) {
        if (fs.existsSync(file) && fs.statSync(file).size > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const raw = fs.readFileSync(file, 'utf-8');
      const lines = raw.trim().split('\n');
      return JSON.parse(lines[lines.length - 1]);
    }

    function freshVault(): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tools-log-'));
      fs.writeFileSync(
        path.join(dir, 'project.toml'),
        `[project]\nid = "${FIXTURE_PROJECT_ID}"\nname = "tools-log-test"\n`,
        'utf-8',
      );
      return dir;
    }

    // createMycoTools now requires a caller-supplied context — the runtime no
    // longer falls back to deriving tenancy from the anchor vault.
    function callerContext(vaultDir: string) {
      return resolveLegacyRequestContext(vaultDir, {
        projectId: FIXTURE_PROJECT_ID,
        machineId: 'test-machine',
        tenancySource: 'caller',
      });
    }

    // Both log-shape tests pair an async dispatcher call with a synchronous
    // log-file read. logActivity() uses fs.appendFileSync (deliberate — see
    // tools/index.ts) so the entry is on disk before await resolves; under
    // heavy parallel test load both the sync write and the immediate
    // readFileSync compete for disk and can exceed the default 2s timeout.
    // 10s preserves the assertion shape without flaking on saturated CI/local
    // runs.
    it('myco_cortex digest log carries tier + duration_ms', async () => {
      const vaultDir = freshVault();
      const tools = createMycoTools(vaultDir, mockClient({
        digest: { tiers: [{ tier: 5000, content: 'd', generated_at: 1 }] },
      }), { requestContext: callerContext(vaultDir) });
      await tools.callTool('myco_cortex', { op: 'digest', tier: 5000 });
      const entry = await readLastLog(vaultDir);
      expect(entry.tool).toBe('myco_cortex');
      expect(entry.op).toBe('digest');
      expect(entry.tier).toBe(5000);
      expect(typeof entry.duration_ms).toBe('number');
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }, 10_000);

    it('myco_search log carries query, matches, and duration_ms', async () => {
      const vaultDir = freshVault();
      const client = mockClient();
      // Override get for the search endpoint so handleMycoSearch returns []
      (client.get as unknown as { mockImplementation: (fn: (e: string) => unknown) => void })
        .mockImplementation(async () => {
          return { ok: true, data: { results: [] } };
        });
      const tools = createMycoTools(vaultDir, client, { requestContext: callerContext(vaultDir) });
      await tools.callTool('myco_search', { query: 'auth' });
      const entry = await readLastLog(vaultDir);
      expect(entry.tool).toBe('myco_search');
      expect(entry.query).toBe('auth');
      expect(entry.matches).toBe(0);
      expect(typeof entry.duration_ms).toBe('number');
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }, 10_000);
  });

  // Stream J — agent-native parity reads on myco_cortex.
  describe('myco_cortex agent-native parity ops (J4)', () => {
    function captureClient(endpointResponses: Record<string, unknown>): { client: DaemonClient; calls: { endpoint: string; headers?: unknown }[] } {
      const calls: { endpoint: string; headers?: unknown }[] = [];
      const client = {
        get: vi.fn(async (endpoint: string, options?: { headers?: unknown }) => {
          calls.push({ endpoint, headers: options?.headers });
          for (const [prefix, body] of Object.entries(endpointResponses)) {
            if (endpoint === prefix || endpoint.startsWith(`${prefix}?`)) {
              return { ok: true, data: body };
            }
          }
          return { ok: true, data: {} };
        }),
        post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      } as unknown as DaemonClient;
      return { client, calls };
    }

    it('op: "notifications" forwards request-context headers and unread_only/limit query params', async () => {
      const { client, calls } = captureClient({
        '/api/notifications': { notifications: [{ id: 'n1' }] },
      });
      const tools = createMycoTools('/tmp/myco-vault', client, { requestContext: FIXTURE_CONTEXT });
      const result = await tools.callTool('myco_cortex', { op: 'notifications', unread_only: true, limit: 5 }) as { notifications: unknown[] };
      expect(result.notifications).toHaveLength(1);
      const call = calls.find((c) => c.endpoint.startsWith('/api/notifications'));
      expect(call).toBeDefined();
      expect(call!.endpoint).toContain('unread_only=true');
      expect(call!.endpoint).toContain('limit=5');
      // Header forwarding is the agent-native contract: the daemon
      // re-resolves request context from these and scopes the read.
      expect(call!.headers).toMatchObject({ 'x-myco-project-id': FIXTURE_PROJECT_ID });
    });

    it('op: "maintenance_summary" forwards request-context headers', async () => {
      const summary = { groves: [], flags: { backup_overdue: 0, optimize_overdue: 0, integrity_issues: 0, error_count: 0 } };
      const { client, calls } = captureClient({ '/api/maintenance/summary': summary });
      const tools = createMycoTools('/tmp/myco-vault', client, { requestContext: FIXTURE_CONTEXT });
      const result = await tools.callTool('myco_cortex', { op: 'maintenance_summary' });
      expect(result).toEqual(summary);
      const call = calls.find((c) => c.endpoint === '/api/maintenance/summary');
      expect(call).toBeDefined();
      expect(call!.headers).toMatchObject({ 'x-myco-project-id': FIXTURE_PROJECT_ID });
    });

    it('op: "projects_activity" returns the daemon body verbatim', async () => {
      const activity = { projects: [], active_window_days: 7, generated_at: '2026-05-08T00:00:00Z' };
      const { client, calls } = captureClient({ '/api/projects/activity': activity });
      const tools = createMycoTools('/tmp/myco-vault', client, { requestContext: FIXTURE_CONTEXT });
      const result = await tools.callTool('myco_cortex', { op: 'projects_activity' });
      expect(result).toEqual(activity);
      const call = calls.find((c) => c.endpoint === '/api/projects/activity');
      expect(call).toBeDefined();
    });

    it('falls back to a typed failure when the daemon returns !ok', async () => {
      const client = {
        get: vi.fn(async () => {
          return { ok: false, data: undefined };
        }),
        post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
        delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
      } as unknown as DaemonClient;
      const tools = createMycoTools('/tmp/myco-vault', client, { requestContext: FIXTURE_CONTEXT });
      await expect(tools.callTool('myco_cortex', { op: 'notifications' }))
        .resolves.toEqual({ ok: false, error: 'Notifications unavailable' });
    });
  });
});
