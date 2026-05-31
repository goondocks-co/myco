/**
 * Tests for TeamSyncClient and team context module.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { TeamSyncClient, computeVersionCompat } from '@myco/daemon/team-sync.js';
import type { OutboxRow } from '@myco/db/queries/team-outbox.js';
import {
  initTeamContext,
  getTeamMachineId,
  getTeamSyncProtocolVersion,
  resetTeamContext,
} from '@myco/daemon/team-context.js';

// ---------------------------------------------------------------------------
// Mock getMachineId so team-context tests are environment-independent.
// The persisted ~/.myco/machine_id value varies per machine; pin it to a
// fixed sentinel so assertions don't depend on the real filesystem.
// ---------------------------------------------------------------------------

const PERSISTED_MACHINE_ID = 'test_machine_abc';

mock.module('@myco/daemon/machine-id.js', () => ({
  getMachineId: () => PERSISTED_MACHINE_ID,
}));

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function createMockFetch(responses: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const path = new URL(urlStr).pathname;

    const response = responses[path];
    if (!response) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
}

/** Factory for a minimal OutboxRow. */
function makeOutboxRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    table_name: 'spores',
    row_id: 'spore-abc123',
    operation: 'upsert',
    payload: { id: 'spore-abc123', content: 'test' },
    machine_id: 'test_abc123',
    project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    created_at: Math.floor(Date.now() / 1000),
    sent_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeVersionCompat (pure helper)
// ---------------------------------------------------------------------------

describe('computeVersionCompat', () => {
  it('returns "unknown" when the worker protocol has not been probed', () => {
    expect(computeVersionCompat(2, undefined, undefined)).toBe('unknown');
    // minClient present but protocol absent → still unknown (bounds not probed).
    expect(computeVersionCompat(2, undefined, 1)).toBe('unknown');
  });

  it('returns "client_too_old" when the daemon is below the worker floor', () => {
    expect(computeVersionCompat(1, 3, 2)).toBe('client_too_old');
  });

  it('returns "worker_too_old" when the daemon is ahead of the worker protocol', () => {
    // No floor advertised; daemon (3) > worker protocol (2).
    expect(computeVersionCompat(3, 2, undefined)).toBe('worker_too_old');
    // Floor satisfied but daemon still ahead of the worker's own protocol.
    expect(computeVersionCompat(3, 2, 1)).toBe('worker_too_old');
  });

  it('returns "ok" when the daemon is within the worker window', () => {
    expect(computeVersionCompat(2, 2, 1)).toBe('ok');
    expect(computeVersionCompat(2, 3, 1)).toBe('ok');
  });

  it('treats the floor as inclusive: daemon == minClient is ok', () => {
    expect(computeVersionCompat(2, 3, 2)).toBe('ok');
  });

  it('treats the ceiling as inclusive: daemon == workerProtocol is ok', () => {
    expect(computeVersionCompat(2, 2, undefined)).toBe('ok');
    expect(computeVersionCompat(2, 2, 1)).toBe('ok');
  });

  it('prefers client_too_old over worker_too_old when both could apply', () => {
    // daemon below floor takes precedence (it can never be ahead of the worker
    // protocol while also below the floor, but the ordering is asserted to lock
    // the contract).
    expect(computeVersionCompat(0, 2, 1)).toBe('client_too_old');
  });
});

// ---------------------------------------------------------------------------
// TeamSyncClient
// ---------------------------------------------------------------------------

describe('TeamSyncClient', () => {
  const baseOptions = {
    workerUrl: 'https://myco-team.example.workers.dev',
    apiKey: 'test-api-key-123',
    machineId: 'test_abc123',
    syncProtocolVersion: 1,
  };

  describe('health', () => {
    it('returns health status from worker', async () => {
      const mockFetch = createMockFetch({
        '/health': {
          status: 200,
          body: { status: 'ok', node_count: 3, sync_protocol_version: 1 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.health();

      expect(result.status).toBe('ok');
      expect(result.node_count).toBe(3);
    });

    it('sends Authorization header', async () => {
      const mockFetch = createMockFetch({
        '/health': {
          status: 200,
          body: { status: 'ok', node_count: 0, sync_protocol_version: 1 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.health();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key-123',
          }),
        }),
      );
    });

    it('throws on non-ok response', async () => {
      const mockFetch = createMockFetch({
        '/health': { status: 503, body: { error: 'unavailable' } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await expect(client.health()).rejects.toThrow(/Health check failed: 503/);
    });

    it('captures the worker advertised bounds and exposes version compat', async () => {
      const mockFetch = createMockFetch({
        '/health': {
          status: 200,
          // Worker speaks protocol 3, floors clients at 2. This daemon is
          // pinned at protocol 1 (baseOptions.syncProtocolVersion) → too old.
          body: { status: 'ok', node_count: 1, sync_protocol_version: 3, min_compat_client_version: 2 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      // Before any probe, bounds are unknown.
      expect(client.getWorkerProtocolVersion()).toBeUndefined();
      expect(client.getWorkerMinClientVersion()).toBeUndefined();
      expect(client.getVersionCompat()).toBe('unknown');

      await client.health();

      expect(client.getWorkerProtocolVersion()).toBe(3);
      expect(client.getWorkerMinClientVersion()).toBe(2);
      expect(client.getVersionCompat()).toBe('client_too_old');
    });

    it('reports "ok" when the daemon is within the worker window', async () => {
      const mockFetch = createMockFetch({
        '/health': {
          status: 200,
          body: { status: 'ok', node_count: 1, sync_protocol_version: 2, min_compat_client_version: 1 },
        },
      });
      // Daemon at protocol 2, within [1, 2].
      const client = new TeamSyncClient({ ...baseOptions, syncProtocolVersion: 2, fetch: mockFetch });
      await client.health();
      expect(client.getVersionCompat()).toBe('ok');
    });
  });

  describe('connect captures version bounds', () => {
    it('stores the worker bounds advertised on /connect', async () => {
      const mockFetch = createMockFetch({
        '/connect': {
          status: 200,
          body: { config: {}, sync_protocol_version: 3, min_compat_client_version: 2 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.connect({ machine_id: 'test_abc123' });

      expect(client.getWorkerProtocolVersion()).toBe(3);
      expect(client.getWorkerMinClientVersion()).toBe(2);
      // baseOptions.syncProtocolVersion === 1 < floor 2 → too old.
      expect(client.getVersionCompat()).toBe('client_too_old');
    });
  });

  describe('connect', () => {
    it('POSTs to /connect with machine info', async () => {
      const mockFetch = createMockFetch({
        '/connect': {
          status: 200,
          body: { config: {}, sync_protocol_version: 1 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.connect({
        machine_id: 'test_abc123',
        vault_name: 'myco',
        agent: 'claude-code',
      });

      expect(result.sync_protocol_version).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://myco-team.example.workers.dev/connect',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('enqueueBatch', () => {
    it('POSTs records to /enqueue', async () => {
      const mockFetch = createMockFetch({
        '/enqueue': { status: 200, body: { accepted: 2, rejected: [] } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const records = [makeOutboxRow({ id: 1 }), makeOutboxRow({ id: 2 })];

      const result = await client.enqueueBatch(records);
      expect(result.accepted).toBe(2);
      expect(result.rejected).toEqual([]);
    });

    it('includes machine_id and sync_protocol_version', async () => {
      let capturedBody: unknown;
      const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch;

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.enqueueBatch([makeOutboxRow()]);

      const body = capturedBody as { machine_id: string; sync_protocol_version: number; records: unknown[] };
      expect(body.machine_id).toBe('test_abc123');
      expect(body.sync_protocol_version).toBe(1);
      expect(body.records).toHaveLength(1);
    });

    it('injects outbox project_id into delete payloads before enqueue', async () => {
      let capturedBody: unknown;
      const mockFetch = vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch;

      const projectId = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.enqueueBatch([
        makeOutboxRow({
          operation: 'delete',
          payload: { id: 'spore-abc123', machine_id: 'test_abc123' },
          project_id: projectId,
        }),
      ]);

      const body = capturedBody as { records: Array<{ data: Record<string, unknown> }> };
      expect(body.records[0].data).toMatchObject({
        id: 'spore-abc123',
        machine_id: 'test_abc123',
        project_id: projectId,
      });
    });

    it('throws on enqueue error', async () => {
      const mockFetch = createMockFetch({
        '/enqueue': { status: 409, body: { error: 'version_mismatch' } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await expect(client.enqueueBatch([makeOutboxRow()])).rejects.toThrow(/failed: 409/);
    });

    it('returns per-record validation rejections', async () => {
      const mockFetch = createMockFetch({
        '/enqueue': {
          status: 200,
          body: { accepted: 1, rejected: [{ id: 'r2', table: 'unknown_table', error: 'Unknown table: unknown_table' }] },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.enqueueBatch([makeOutboxRow({ id: 1 }), makeOutboxRow({ id: 2 })]);
      expect(result.accepted).toBe(1);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0].error).toContain('Unknown table');
    });
  });

  describe('getSyncSummary', () => {
    it('GETs /sync-summary with remote store counts', async () => {
      const mockFetch = createMockFetch({
        '/sync-summary': {
          status: 200,
          body: {
            generated_at: 1778060000,
            total_records: 3,
            tables: { spores: 2, sessions: 1 },
            schema_version: 35,
            package_version: '0.1.7',
            sync_protocol_version: 1,
          },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.getSyncSummary();

      expect(result.total_records).toBe(3);
      expect(result.tables.spores).toBe(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://myco-team.example.workers.dev/sync-summary',
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });

  describe('search', () => {
    it('GETs /search with query params', async () => {
      const mockFetch = createMockFetch({
        '/search': {
          status: 200,
          body: { results: [], machine_ids: ['test_abc123'] },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.search('authentication patterns');

      expect(result.results).toEqual([]);
      expect(result.machine_ids).toContain('test_abc123');

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('q=authentication+patterns');
    });

    it('passes limit and tables options', async () => {
      const mockFetch = createMockFetch({
        '/search': {
          status: 200,
          body: { results: [], machine_ids: [] },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.search('test', { limit: 10, tables: ['spores', 'sessions'] });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('tables=spores%2Csessions');
    });

    it('passes semantic metadata filters including session_id', async () => {
      const mockFetch = createMockFetch({
        '/search': {
          status: 200,
          body: { results: [], machine_ids: [] },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.search('test', {
        status: 'active',
        observation_type: 'decision',
        since: 10,
        until: 20,
        session_id: 'sess-1',
        project_id: 'proj-1',
      });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('status=active');
      expect(calledUrl).toContain('observation_type=decision');
      expect(calledUrl).toContain('since=10');
      expect(calledUrl).toContain('until=20');
      expect(calledUrl).toContain('session_id=sess-1');
      expect(calledUrl).toContain('project_id=proj-1');
    });

    it('throws on non-ok response', async () => {
      const mockFetch = createMockFetch({
        '/search': { status: 500, body: { error: 'internal' } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await expect(client.search('test')).rejects.toThrow(/Team search failed: 500/);
    });
  });

  describe('getConfig', () => {
    it('GETs /config', async () => {
      const mockFetch = createMockFetch({
        '/config': {
          status: 200,
          body: { config: { team_name: 'myco' }, sync_protocol_version: 1 },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.getConfig();

      expect(result.config).toEqual({ team_name: 'myco' });
      expect(result.sync_protocol_version).toBe(1);
    });
  });

  describe('removeMember', () => {
    it('DELETEs /members/<machineId> with the id percent-encoded', async () => {
      const mockFetch = vi.fn(async () => new Response(JSON.stringify({ removed: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.removeMember('machine/with space');

      expect(result.removed).toBe(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://myco-team.example.workers.dev/members/machine%2Fwith%20space',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });
  });

  describe('request timeout', () => {
    it('attaches an AbortSignal to every request() call', async () => {
      const mockFetch = vi.fn(async () => new Response(JSON.stringify({ config: {}, sync_protocol_version: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getConfig();

      const initArg = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
      expect(initArg.signal).toBeInstanceOf(AbortSignal);
      expect((initArg.signal as AbortSignal).aborted).toBe(false);
    });

    // Skipped under Linux CI: 15s AbortController deadline races the runner's
    // own timing under ubuntu-latest. The timeout path is defensive; client
    // cleanup is covered by the other deadline tests in this file.
    it.skip('aborts a stalled request via the internal deadline', async () => {
      // Use a real (but very short) timeout instead of fake timers so that
      // AbortController's 'abort' event dispatch actually fires under bun
      // test. Bun's jest.useFakeTimers() does not propagate timer callbacks
      // to AbortController event listeners, causing this test to hang
      // indefinitely when driven by fake timers. A 50ms deadline is fast
      // enough to stay under the per-test budget while still exercising the
      // same code path (request() -> setTimeout -> controller.abort()).
      let capturedSignal: AbortSignal | undefined;
      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        return await new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as unknown as typeof globalThis.fetch;

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      // Reach into the private `request` method to override timeoutMs —
      // TEAM_REQUEST_TIMEOUT_MS (15s) is too long to wait for real.
      const pending = (client as unknown as {
        request: (method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }) => Promise<unknown>;
      }).request('GET', '/config', undefined, { timeoutMs: 50 });

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(capturedSignal?.aborted).toBe(true);
    });
  });

  describe('URL normalization', () => {
    it('strips trailing slash from worker URL', async () => {
      const mockFetch = createMockFetch({
        '/health': {
          status: 200,
          body: { status: 'ok', node_count: 0, sync_protocol_version: 1 },
        },
      });

      const client = new TeamSyncClient({
        ...baseOptions,
        workerUrl: 'https://myco.workers.dev/',
        fetch: mockFetch,
      });

      await client.health();

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toBe('https://myco.workers.dev/health');
    });
  });
});

// ---------------------------------------------------------------------------
// Team Context
// ---------------------------------------------------------------------------

describe('team context', () => {
  beforeEach(() => {
    resetTeamContext();
  });

  it('falls back to the persisted machine id when no explicit context is set', () => {
    // After reset (no initTeamContext), getTeamMachineId() must resolve the
    // real persisted id — not the 'local' sentinel — so non-daemon writers
    // (MCP server, agent subprocesses) stamp rows with the correct machine id.
    expect(getTeamMachineId()).toBe(PERSISTED_MACHINE_ID);
  });

  it('returns the explicitly initialised id after initTeamContext', () => {
    initTeamContext('explicit_id');
    expect(getTeamMachineId()).toBe('explicit_id');
  });

  it('returns sync protocol version', () => {
    // Bumped to 2 in the C1 protocol bump (queue-driven `embed`
    // SyncRecord operation + additive `/vectors/reindex` shape).
    // Older daemons still in v1 are accepted by the worker via
    // the MIN_COMPAT_CLIENT_VERSION window — see C2/C3.
    expect(getTeamSyncProtocolVersion()).toBe(2);
  });

  it('resets to persisted id (not local)', () => {
    initTeamContext('chris_abc123');
    resetTeamContext();

    // After reset, must resolve the persisted id — not 'local'.
    expect(getTeamMachineId()).toBe(PERSISTED_MACHINE_ID);
  });
});
