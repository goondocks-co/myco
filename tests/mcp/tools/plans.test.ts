/**
 * Tests for myco_plans tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoPlans } from '@myco/mcp/tools/plans.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_plans', () => {
  it('lists plans from daemon response', async () => {
    const plans = [
      { id: 'auth', title: 'Auth Redesign', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 },
      { id: 'done', title: 'Completed Plan', status: 'completed', progress: '1/1', tags: [], created_at: 1699999900 },
    ];
    const client = mockClient({ plans });

    const results = await handleMycoPlans({}, client);
    expect(results).toHaveLength(2);
  });

  it('passes status filter to daemon', async () => {
    const client = mockClient({ plans: [{ id: 'auth', title: 'Auth', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 }] });

    const results = await handleMycoPlans({ status: 'active' }, client);
    expect(results).toHaveLength(1);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('status=active'));
  });

  it('returns empty on daemon failure', async () => {
    const client = mockClient(null, false);
    const results = await handleMycoPlans({}, client);
    expect(results).toEqual([]);
  });

  it('passes limit to daemon', async () => {
    const client = mockClient({ plans: [] });
    await handleMycoPlans({ limit: 5 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
  });
});
