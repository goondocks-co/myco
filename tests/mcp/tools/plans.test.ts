/**
 * Tests for myco_plans tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping, and cover the
 * Bundle D additions: op discriminator, session filter, and delete op.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoPlans } from '@myco/mcp/tools/plans.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
    delete: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_plans op: list (default)', () => {
  it('lists plans from daemon response', async () => {
    const plans = [
      { id: 'auth', title: 'Auth Redesign', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 },
      { id: 'done', title: 'Completed Plan', status: 'completed', progress: '1/1', tags: [], created_at: 1699999900 },
    ];
    const client = mockClient({ plans });

    const results = await handleMycoPlans({}, client);
    expect(Array.isArray(results)).toBe(true);
    expect((results as unknown[]).length).toBe(2);
  });

  it('passes status filter to daemon', async () => {
    const client = mockClient({ plans: [{ id: 'auth', title: 'Auth', status: 'active', progress: '1/2', tags: [], created_at: 1700000000 }] });

    const results = await handleMycoPlans({ status: 'active' }, client);
    expect((results as unknown[]).length).toBe(1);
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

  it('forwards id to daemon when looking up a specific plan', async () => {
    const client = mockClient({
      plans: [{
        id: 'plan-auth',
        title: 'Auth',
        status: 'active',
        progress: '0/3',
        tags: [],
        created_at: 1700000000,
        content: '# Plan content here',
      }],
    });
    await handleMycoPlans({ id: 'plan-auth' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('id=plan-auth'));
  });

  it('surfaces plan content on single-plan lookup response', async () => {
    const content = '# Auth Redesign\n\n- [x] Step 1\n- [ ] Step 2';
    const client = mockClient({
      plans: [{ id: 'plan-auth', title: 'Auth', status: 'active', progress: '1/2', tags: [], created_at: 1700000000, content }],
    });
    const results = await handleMycoPlans({ id: 'plan-auth' }, client);
    expect((results as Array<{ content?: string }>)[0].content).toBe(content);
  });

  it('forwards session filter to daemon', async () => {
    const client = mockClient({ plans: [] });
    await handleMycoPlans({ session: 'sess-abc' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('session=sess-abc'));
  });

  it('refuses both id and session in same list call', async () => {
    const client = mockClient({ plans: [] });
    const result = await handleMycoPlans({ id: 'p1', session: 'sess-1' }, client);
    expect(result).toEqual([]);
    // No HTTP roundtrip should happen when the input is contradictory.
    expect(client.get).not.toHaveBeenCalled();
  });

  it('explicit op: "list" works the same as default', async () => {
    const plans = [{ id: 'auth', title: 'A', status: 'active', progress: '0/0', tags: [], created_at: 0 }];
    const client = mockClient({ plans });
    const r = await handleMycoPlans({ op: 'list' }, client);
    expect((r as unknown[]).length).toBe(1);
  });
});

describe('myco_plans op: delete', () => {
  it('requires id', async () => {
    const client = mockClient({ ok: true });
    const result = await handleMycoPlans({ op: 'delete' }, client);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('id is required') });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('calls DELETE /api/plans/:id without body when local', async () => {
    const client = mockClient({ ok: true, id: 'plan-1', session_id: 'sess-1' });
    const result = await handleMycoPlans({ op: 'delete', id: 'plan-1' }, client);
    expect(client.delete).toHaveBeenCalledWith('/api/plans/plan-1', undefined);
    expect(result).toMatchObject({ ok: true, id: 'plan-1', session_id: 'sess-1' });
  });

  it('forwards force_remote to the daemon when set', async () => {
    const client = mockClient({ ok: true, id: 'plan-2', session_id: 'sess-2' });
    await handleMycoPlans({ op: 'delete', id: 'plan-2', force_remote: true }, client);
    expect(client.delete).toHaveBeenCalledWith('/api/plans/plan-2', { force_remote: true });
  });

  it('surfaces the daemon-side rejection when force_remote is omitted for a remote plan', async () => {
    // DaemonClient.delete returns { ok: false } when the HTTP call is !res.ok;
    // the handler converts that into a structured error payload.
    const client = {
      get: vi.fn(),
      post: vi.fn(),
      delete: vi.fn().mockResolvedValue({
        ok: false,
        data: { error: 'Plan belongs to another machine; pass {"force_remote": true} to delete.' },
      }),
    } as unknown as DaemonClient;
    const result = await handleMycoPlans({ op: 'delete', id: 'plan-x' }, client);
    expect(result).toMatchObject({ ok: false });
  });
});
