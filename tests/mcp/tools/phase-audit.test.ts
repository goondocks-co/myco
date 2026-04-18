/**
 * Tests for myco_phase_audit tool handler.
 *
 * Mirrors GET /api/agent/runs/:id/audit. Adapter-layer only.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoPhaseAudit } from '@myco/mcp/tools/phase-audit.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_phase_audit', () => {
  it('requires run_id', async () => {
    const client = mockClient({});
    const result = await handleMycoPhaseAudit({ run_id: '' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run_id/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/agent/runs/:id/audit', async () => {
    const payload = {
      audit: {
        run: { id: 'run-1', status: 'completed' },
        phases: [
          { name: 'plan', turns: 3, tokensUsed: 500, costUsd: 0.001 },
          { name: 'execute', turns: 7, tokensUsed: 2000, costUsd: 0.004 },
        ],
      },
    };
    const client = mockClient(payload);
    const result = await handleMycoPhaseAudit({ run_id: 'run-1' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/agent/runs/run-1/audit');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('URL-encodes the run_id path segment', async () => {
    const client = mockClient({ audit: {} });
    await handleMycoPhaseAudit({ run_id: 'run id with spaces' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/agent/runs/run%20id%20with%20spaces/audit');
  });

  it('surfaces a not-found error from the daemon', async () => {
    const client = mockClient({ error: 'Run not found' }, false);
    const result = await handleMycoPhaseAudit({ run_id: 'missing' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Run not found');
  });

  it('falls back to not_found when the daemon is unreachable (no body)', async () => {
    const client = mockClient(undefined, false);
    const result = await handleMycoPhaseAudit({ run_id: 'run-1' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });
});
