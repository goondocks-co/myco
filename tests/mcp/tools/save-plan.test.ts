/**
 * Tests for myco_save_plan tool handler.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSavePlan } from '@myco/tools/save-plan.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('myco_save_plan', () => {
  it('posts the save-plan request to the daemon and returns saved metadata', async () => {
    const client = mockClient({
      id: 'plan-1234',
      logical_key: 'session:sess-1:key:primary',
      title: 'Primary Plan',
      status: 'active',
      source_path: null,
      session_id: 'sess-1',
      prompt_batch_id: 9,
      tags: ['planning'],
      created_at: 1700000000,
      updated_at: 1700000000,
    });

    const result = await handleMycoSavePlan({
      session_id: 'sess-1',
      content: '# Primary Plan',
      plan_key: 'primary',
      tags: ['planning'],
    }, client);

    expect(client.post).toHaveBeenCalledWith('/api/mcp/plans', {
      session_id: 'sess-1',
      content: '# Primary Plan',
      source_path: undefined,
      plan_key: 'primary',
      title: undefined,
      status: undefined,
      tags: ['planning'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.id).toBe('plan-1234');
      expect(result.logical_key).toBe('session:sess-1:key:primary');
    }
  });

  it('returns a structured error when the daemon save fails', async () => {
    const client = mockClient({ error: 'save-failed' }, false);
    const result = await handleMycoSavePlan({
      session_id: 'sess-1',
      content: '# Plan',
      plan_key: 'primary',
    }, client);

    expect(result).toEqual({ ok: false, error: 'save-failed' });
  });

  it('falls back to "unknown" when the failure payload lacks an error string', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSavePlan({
      session_id: 'sess-1',
      content: '# Plan',
      plan_key: 'primary',
    }, client);

    expect(result).toEqual({ ok: false, error: 'unknown' });
  });
});
