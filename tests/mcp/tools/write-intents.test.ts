/**
 * Tests for myco_write_intents tool handler.
 *
 * Mirrors GET /api/agent/runs/:id/write-intents. Adapter-layer only.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoWriteIntents } from '@myco/mcp/tools/write-intents.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_write_intents', () => {
  it('requires run_id', async () => {
    const client = mockClient({});
    const result = await handleMycoWriteIntents({ run_id: '' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run_id/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/agent/runs/:id/write-intents', async () => {
    const payload = {
      intents: [{ id: 1, run_id: 'run-1', tool_name: 'fs.write', tool_input: { path: '/tmp/x' }, synthetic_output: { ok: true } }],
      count: 1,
      total: 1,
    };
    const client = mockClient(payload);
    const result = await handleMycoWriteIntents({ run_id: 'run-1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/agent/runs/run-1/write-intents');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('forwards limit and offset as query params', async () => {
    const client = mockClient({ intents: [], count: 0, total: 0 });
    await handleMycoWriteIntents({ run_id: 'run-1', limit: 10, offset: 5 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/agent/runs/run-1/write-intents');
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=5');
  });

  it('URL-encodes the run_id path segment', async () => {
    const client = mockClient({ intents: [], count: 0, total: 0 });
    await handleMycoWriteIntents({ run_id: 'run/with slash' }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('run%2Fwith%20slash');
  });

  it('surfaces the daemon error body when non-ok', async () => {
    const client = mockClient({ error: 'Run not found' }, false);
    const result = await handleMycoWriteIntents({ run_id: 'missing' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Run not found');
  });

  it('falls back to fetch_failed when the daemon is unreachable (no body)', async () => {
    const client = mockClient(undefined, false);
    const result = await handleMycoWriteIntents({ run_id: 'run-1' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fetch_failed');
  });
});
