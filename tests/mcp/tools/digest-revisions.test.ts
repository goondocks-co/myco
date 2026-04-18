/**
 * Tests for myco_digest_revisions tool handler.
 *
 * Mirrors GET /api/digest/revisions. Adapter-layer only (restore is UI-only
 * and intentionally NOT exposed through this tool).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoDigestRevisions } from '@myco/mcp/tools/digest-revisions.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_digest_revisions', () => {
  it('requires tier (the daemon route 400s without it)', async () => {
    const client = mockClient({});
    const result = await handleMycoDigestRevisions({}, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tier/);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/digest/revisions with tier', async () => {
    const payload = { revisions: [{ id: 7, agent_id: 'myco-agent', tier: 5000, content: '...' }], count: 1 };
    const client = mockClient(payload);
    const result = await handleMycoDigestRevisions({ tier: 5000 }, client);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/digest/revisions');
    expect(url).toContain('tier=5000');
  });

  it('forwards agent_id as agentId to the route', async () => {
    const client = mockClient({ revisions: [], count: 0 });
    await handleMycoDigestRevisions({ agent_id: 'review-agent', tier: 1500 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('agentId=review-agent');
    expect(url).toContain('tier=1500');
  });

  it('forwards limit', async () => {
    const client = mockClient({ revisions: [], count: 0 });
    await handleMycoDigestRevisions({ tier: 5000, limit: 10 }, client);
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('limit=10');
  });

  it('surfaces the daemon error body on non-ok', async () => {
    const client = mockClient({ error: 'tier must be numeric, got foo' }, false);
    const result = await handleMycoDigestRevisions({ tier: 5000 }, client);
    // The tool already forwarded tier — the 400 here is a stand-in for any
    // route-side rejection. Assert the error body string reaches the caller.
    expect(result.ok).toBe(false);
    expect(result.error).toBe('tier must be numeric, got foo');
  });

  it('falls back to fetch_failed when the daemon is unreachable', async () => {
    const client = mockClient(undefined, false);
    const result = await handleMycoDigestRevisions({ tier: 5000 }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fetch_failed');
  });
});
