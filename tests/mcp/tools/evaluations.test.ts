/**
 * Tests for myco_evaluations tool handler.
 *
 * Mirrors /api/agent/evaluations. These tests verify the MCP adapter
 * layer only (schema forwarding, op dispatch, error surfacing) — the
 * matrix fan-out and run serialization are exercised elsewhere.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoEvaluations } from '@myco/mcp/tools/evaluations.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_evaluations op: list (default)', () => {
  it('GETs /api/agent/evaluations without forwarding an unset limit', async () => {
    const payload = { evaluations: [{ id: 'e-1', taskId: 'skill-generate', status: 'completed', createdAt: 1, completedAt: 2, matrix: {}, notes: null }], total: 1 };
    const client = mockClient(payload);
    const result = await handleMycoEvaluations({}, client);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/agent/evaluations');
    expect(url).not.toContain('limit=');
  });

  it('forwards limit when set', async () => {
    const client = mockClient({ evaluations: [], total: 0 });
    await handleMycoEvaluations({ op: 'list', limit: 3 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('limit=3');
  });

  it('surfaces the richer error body when the daemon rejects', async () => {
    const client = mockClient({ error: { code: 'ouch', message: 'daemon down' } }, false);
    const result = await handleMycoEvaluations({ op: 'list' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('daemon down');
  });
});

describe('myco_evaluations op: get', () => {
  it('requires id', async () => {
    const client = mockClient({});
    const result = await handleMycoEvaluations({ op: 'get' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id is required/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/agent/evaluations/:id', async () => {
    const payload = {
      evaluation: { id: 'eval-42', taskId: 'skill-generate', matrix: {}, notes: null, status: 'completed', createdAt: 1, completedAt: 2 },
      runs: [],
      aggregate: { total: 0, completed: 0, failed: 0, skipped: 0, totalTokens: 0, totalCostUsd: 0 },
    };
    const client = mockClient(payload);
    const result = await handleMycoEvaluations({ op: 'get', id: 'eval-42' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/agent/evaluations/eval-42');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('surfaces "Evaluation not found" from the daemon 404 body', async () => {
    const client = mockClient({ error: 'Evaluation not found' }, false);
    const result = await handleMycoEvaluations({ op: 'get', id: 'missing' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Evaluation not found');
  });
});

describe('myco_evaluations op: create', () => {
  it('requires task_id', async () => {
    const client = mockClient({});
    const result = await handleMycoEvaluations({ op: 'create', matrix: { runtimes: ['claude-sdk'] } }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/task_id/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('requires matrix', async () => {
    const client = mockClient({});
    const result = await handleMycoEvaluations({ op: 'create', task_id: 'skill-generate' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/matrix/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('POSTs taskId and matrix to /api/agent/evaluations', async () => {
    const client = mockClient({ evaluationId: 'e-1', cellCount: 2 });
    const result = await handleMycoEvaluations(
      {
        op: 'create',
        task_id: 'skill-generate',
        matrix: { runtimes: ['claude-sdk'], reasoningLevels: ['low', 'high'] },
      },
      client,
    );
    expect(client.post).toHaveBeenCalledWith('/api/agent/evaluations', {
      taskId: 'skill-generate',
      matrix: { runtimes: ['claude-sdk'], reasoningLevels: ['low', 'high'] },
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ evaluationId: 'e-1', cellCount: 2 });
  });

  it('forwards notes when provided', async () => {
    const client = mockClient({ evaluationId: 'e-1', cellCount: 1 });
    await handleMycoEvaluations(
      { op: 'create', task_id: 'skill-generate', matrix: {}, notes: 'tuning prompt v2' },
      client,
    );
    expect(client.post).toHaveBeenCalledWith('/api/agent/evaluations', {
      taskId: 'skill-generate',
      matrix: {},
      notes: 'tuning prompt v2',
    });
  });

  it('surfaces the zod validation error body from the route', async () => {
    const client = mockClient({ error: 'Invalid request body' }, false);
    const result = await handleMycoEvaluations(
      { op: 'create', task_id: 'bad', matrix: { runtimes: ['not-a-runtime'] } },
      client,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid request body');
  });
});
