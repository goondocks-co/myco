/**
 * Tests for myco_spores supersede handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSpores } from '@myco/tools/spores.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_spores op: supersede', () => {
  it('supersedes a spore and returns success', async () => {
    const client = mockClient({
      old_spore: 'old-spore',
      new_spore: 'new-spore',
      status: 'superseded',
    });

    const result = await handleMycoSpores({
      op: 'supersede',
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

    await handleMycoSpores({
      op: 'supersede',
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

  it('returns a structured error on daemon failure', async () => {
    const client = mockClient(null, false);

    await expect(handleMycoSpores({
      op: 'supersede',
      old_spore_id: 'nonexistent',
      new_spore_id: 'new-spore',
    }, client)).resolves.toEqual({ ok: false, error: 'Failed to supersede spore' });
  });
});
