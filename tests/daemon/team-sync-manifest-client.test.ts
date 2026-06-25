/**
 * Tests for TeamSyncClient.getManifest() and supportsManifest().
 */

import { describe, it, expect, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { TeamSyncClient } from '@myco/daemon/team-sync.js';

// ---------------------------------------------------------------------------
// Mock getMachineId so tests are environment-independent.
// ---------------------------------------------------------------------------

mock.module('@myco/machine-id.js', () => ({
  getMachineId: () => 'test_machine_abc',
}));

// ---------------------------------------------------------------------------
// Mock fetch helper
// ---------------------------------------------------------------------------

function createMockFetch(responses: Record<string, { status: number; body: unknown }>) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
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

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseOptions = {
  workerUrl: 'https://myco-team.example.workers.dev',
  apiKey: 'test-api-key-123',
  machineId: 'test_abc123',
  syncProtocolVersion: 2,
};

const SUMMARY_BODY = {
  table: 'spores',
  machine_id: 'test_abc123',
  count: 5,
};

const PAGED_BODY = {
  table: 'sessions',
  machine_id: 'test_abc123',
  count: 3,
  items: [
    { id: 'sess-001', project_id: 'proj_aaa', content_hash: 'abc123' },
    { id: 'sess-002', project_id: 'proj_aaa', content_hash: 'def456' },
    { id: 'sess-003', project_id: 'proj_bbb' },
  ],
  next_cursor: 'cursor-xyz',
};

// ---------------------------------------------------------------------------
// getManifest — path and query-string construction
// ---------------------------------------------------------------------------

describe('TeamSyncClient.getManifest', () => {
  describe('summary mode (summary=1)', () => {
    it('builds /manifest with machine_id, table, and summary=1', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: SUMMARY_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.getManifest('test_abc123', 'spores', { summary: true });

      expect(result.table).toBe('spores');
      expect(result.machine_id).toBe('test_abc123');
      expect(result.count).toBe(5);
      expect('items' in result).toBe(false);

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/manifest');
      expect(calledUrl).toContain('machine_id=test_abc123');
      expect(calledUrl).toContain('table=spores');
      expect(calledUrl).toContain('summary=1');
    });

    it('includes projectId in the query string when provided', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: { ...SUMMARY_BODY, project_id: 'proj_aaa' } },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'spores', {
        summary: true,
        projectId: 'proj_aaa',
      });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('project_id=proj_aaa');
      expect(calledUrl).toContain('summary=1');
    });

    it('omits projectId from the query string when not provided', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: SUMMARY_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'spores', { summary: true });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('project_id=');
    });
  });

  describe('paged mode (default)', () => {
    it('builds /manifest with machine_id and table only (no summary param)', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: PAGED_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.getManifest('test_abc123', 'sessions', {});

      expect(result.table).toBe('sessions');
      expect(result.machine_id).toBe('test_abc123');
      expect(result.count).toBe(3);
      expect(result.items).toHaveLength(3);
      expect(result.next_cursor).toBe('cursor-xyz');

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('machine_id=test_abc123');
      expect(calledUrl).toContain('table=sessions');
      expect(calledUrl).not.toContain('summary=');
    });

    it('includes cursor and limit when provided', async () => {
      const mockFetch = createMockFetch({
        '/manifest': {
          status: 200,
          body: { ...PAGED_BODY, items: [], next_cursor: undefined },
        },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'sessions', {
        cursor: 'cursor-xyz',
        limit: 50,
      });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('cursor=cursor-xyz');
      expect(calledUrl).toContain('limit=50');
    });

    it('omits cursor and limit from the query string when not provided', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: PAGED_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'sessions', {});

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('cursor=');
      expect(calledUrl).not.toContain('limit=');
    });

    it('includes all optional params together', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: PAGED_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'sessions', {
        projectId: 'proj_aaa',
        cursor: 'cursor-abc',
        limit: 100,
      });

      const calledUrl = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(calledUrl).toContain('project_id=proj_aaa');
      expect(calledUrl).toContain('cursor=cursor-abc');
      expect(calledUrl).toContain('limit=100');
      expect(calledUrl).not.toContain('summary=');
    });

    it('returns parsed items with optional content_hash', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: PAGED_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      const result = await client.getManifest('test_abc123', 'sessions', {});

      // items[0] and [1] have content_hash; items[2] does not
      expect(result.items?.[0]?.content_hash).toBe('abc123');
      expect(result.items?.[1]?.content_hash).toBe('def456');
      expect(result.items?.[2]?.content_hash).toBeUndefined();
    });
  });

  describe('HTTP method', () => {
    it('issues a GET request', async () => {
      const mockFetch = createMockFetch({
        '/manifest': { status: 200, body: SUMMARY_BODY },
      });

      const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
      await client.getManifest('test_abc123', 'spores', { summary: true });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ method: 'GET' }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// supportsManifest — feature detect
// ---------------------------------------------------------------------------

describe('TeamSyncClient.supportsManifest', () => {
  it('returns false when worker protocol version has not been probed (undefined)', () => {
    const client = new TeamSyncClient({ ...baseOptions });
    expect(client.getWorkerProtocolVersion()).toBeUndefined();
    expect(client.supportsManifest()).toBe(false);
  });

  it('returns false when worker protocol version is below 3', async () => {
    const mockFetch = createMockFetch({
      '/health': {
        status: 200,
        body: { status: 'ok', node_count: 1, sync_protocol_version: 2 },
      },
    });

    const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
    await client.health();

    expect(client.getWorkerProtocolVersion()).toBe(2);
    expect(client.supportsManifest()).toBe(false);
  });

  it('returns false when worker protocol version is 1', async () => {
    const mockFetch = createMockFetch({
      '/health': {
        status: 200,
        body: { status: 'ok', node_count: 1, sync_protocol_version: 1 },
      },
    });

    const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
    await client.health();

    expect(client.supportsManifest()).toBe(false);
  });

  it('returns true when worker protocol version is exactly 3', async () => {
    const mockFetch = createMockFetch({
      '/health': {
        status: 200,
        body: { status: 'ok', node_count: 1, sync_protocol_version: 3 },
      },
    });

    const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
    await client.health();

    expect(client.getWorkerProtocolVersion()).toBe(3);
    expect(client.supportsManifest()).toBe(true);
  });

  it('returns true when worker protocol version is above 3', async () => {
    const mockFetch = createMockFetch({
      '/health': {
        status: 200,
        body: { status: 'ok', node_count: 1, sync_protocol_version: 4 },
      },
    });

    const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
    await client.health();

    expect(client.supportsManifest()).toBe(true);
  });

  it('returns true when version is populated via connect (not health)', async () => {
    const mockFetch = createMockFetch({
      '/connect': {
        status: 200,
        body: { config: {}, sync_protocol_version: 3 },
      },
    });

    const client = new TeamSyncClient({ ...baseOptions, fetch: mockFetch });
    await client.connect({ machine_id: 'test_abc123' });

    expect(client.supportsManifest()).toBe(true);
  });
});
