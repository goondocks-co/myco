/**
 * Tests for myco_runs tool handler.
 *
 * Mirrors /api/agent/runs[/:id]. These tests verify the MCP adapter
 * layer only — the serializeRun path is exercised by HTTP tests.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoRuns } from '@myco/tools/runs.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_runs op: list (default)', () => {
  it('lists runs from /api/agent/runs and defers the default limit to the HTTP route', async () => {
    const payload = { runs: [{ id: 'run-1', agent_id: 'myco-agent', tokens_used: 100 }], total: 1, offset: 0, limit: 50 };
    const client = mockClient(payload);
    const result = await handleMycoRuns({}, client);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/agent/runs');
    // When the caller omits `limit`, the MCP tool must NOT forward one —
    // the HTTP route owns the default (AGENT_RUNS_DEFAULT_LIMIT).
    expect(url).not.toContain('limit=');
  });

  it('forwards task, agent_id, and limit', async () => {
    const client = mockClient({ runs: [], total: 0 });
    await handleMycoRuns(
      { op: 'list', task: 'skill-generate', agent_id: 'myco-agent', limit: 5 },
      client,
    );
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('task=skill-generate');
    expect(url).toContain('agentId=myco-agent');
    expect(url).toContain('limit=5');
  });

  it('returns fetch_failed when daemon is unhealthy', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoRuns({ op: 'list' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fetch_failed');
  });
});

describe('myco_runs op: get', () => {
  it('requires id', async () => {
    const client = mockClient({});
    const result = await handleMycoRuns({ op: 'get' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id is required/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/agent/runs/:id', async () => {
    const payload = {
      run: {
        id: 'run-42',
        agent_id: 'myco-agent',
        task: 'skill-generate',
        tokens_used: 12000,
        cost_usd: 0.042,
        reasoning_level: 'medium',
        status: 'completed',
        write_intents: { total: 0, by_tool: {} },
        duration_ms: 1500,
      },
    };
    const client = mockClient(payload);
    const result = await handleMycoRuns({ op: 'get', id: 'run-42' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/agent/runs/run-42');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('returns not_found when the daemon returns 404', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoRuns({ op: 'get', id: 'missing' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });
});
