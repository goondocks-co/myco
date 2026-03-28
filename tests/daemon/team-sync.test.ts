/**
 * Tests for TeamSyncClient and team context module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TeamSyncClient } from '../../src/daemon/team-sync.js';
import type { OutboxRow } from '../../src/db/queries/team-outbox.js';
import {
  initTeamContext,
  isTeamSyncEnabled,
  getTeamMachineId,
  getTeamSyncProtocolVersion,
  resetTeamContext,
} from '../../src/daemon/team-context.js';

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
    payload: JSON.stringify({ id: 'spore-abc123', content: 'test' }),
    machine_id: 'test_abc123',
    created_at: Math.floor(Date.now() / 1000),
    sent_at: null,
    ...overrides,
  };
}

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

  describe('pushBatch', () => {
    it('POSTs records to /sync', async () => {
      const mockFetch = createMockFetch({
        '/sync': { status: 200, body: { accepted: 2 } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const records = [makeOutboxRow({ id: 1 }), makeOutboxRow({ id: 2 })];

      const result = await client.pushBatch(records);
      expect(result.accepted).toBe(2);
    });

    it('includes machine_id and sync_protocol_version', async () => {
      let capturedBody: unknown;
      const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ accepted: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as unknown as typeof globalThis.fetch;

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.pushBatch([makeOutboxRow()]);

      const body = capturedBody as { machine_id: string; sync_protocol_version: number; records: unknown[] };
      expect(body.machine_id).toBe('test_abc123');
      expect(body.sync_protocol_version).toBe(1);
      expect(body.records).toHaveLength(1);
    });

    it('throws on sync error', async () => {
      const mockFetch = createMockFetch({
        '/sync': { status: 409, body: { error: 'version_mismatch' } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await expect(client.pushBatch([makeOutboxRow()])).rejects.toThrow(/failed: 409/);
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

  it('defaults to disabled', () => {
    expect(isTeamSyncEnabled()).toBe(false);
    expect(getTeamMachineId()).toBe('local');
  });

  it('enables when initialized', () => {
    initTeamContext(true, 'chris_abc123');

    expect(isTeamSyncEnabled()).toBe(true);
    expect(getTeamMachineId()).toBe('chris_abc123');
  });

  it('disables when initialized with false', () => {
    initTeamContext(true, 'chris_abc123');
    initTeamContext(false, 'chris_abc123');

    expect(isTeamSyncEnabled()).toBe(false);
  });

  it('returns sync protocol version', () => {
    expect(getTeamSyncProtocolVersion()).toBe(1);
  });

  it('resets to defaults', () => {
    initTeamContext(true, 'chris_abc123');
    resetTeamContext();

    expect(isTeamSyncEnabled()).toBe(false);
    expect(getTeamMachineId()).toBe('local');
  });
});
