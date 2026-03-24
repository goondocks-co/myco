/**
 * Tests for myco_supersede tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSupersede } from '@myco/mcp/tools/supersede.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_supersede', () => {
  it('supersedes a spore and returns success', async () => {
    const client = mockClient({
      old_spore: 'old-spore',
      new_spore: 'new-spore',
      status: 'superseded',
    });

    const result = await handleMycoSupersede({
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Bug was fixed',
    }, client);

    expect(result.status).toBe('superseded');
    expect(result.old_spore).toBe('old-spore');
    expect(result.new_spore).toBe('new-spore');
  });

  it('posts to daemon with correct body', async () => {
    const client = mockClient({
      old_spore: 'old-spore',
      new_spore: 'new-spore',
      status: 'superseded',
    });

    await handleMycoSupersede({
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Test reason',
    }, client);

    expect(client.post).toHaveBeenCalledWith('/api/mcp/supersede', {
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Test reason',
    });
  });

  it('throws on daemon failure', async () => {
    const client = mockClient(null, false);

    await expect(handleMycoSupersede({
      old_spore_id: 'nonexistent',
      new_spore_id: 'new-spore',
    }, client)).rejects.toThrow('Failed to supersede spore');
  });
});
