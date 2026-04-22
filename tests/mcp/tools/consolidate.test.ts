/**
 * Tests for myco_consolidate tool handler.
 *
 * The handler proxies through DaemonClient to POST /api/mcp/consolidate.
 * Tests mock the client to verify endpoint usage and response mapping.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoConsolidate } from '@myco/mcp/tools/consolidate.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('myco_consolidate', () => {
  it('posts to daemon with full body and returns the consolidation result', async () => {
    const client = mockClient({
      new_spore_id: 'gotcha-newwisdom',
      sources_superseded: ['g-1', 'g-2', 'g-3'],
      status: 'consolidated',
      created_at: 1700000000,
    });

    const result = await handleMycoConsolidate({
      source_spore_ids: ['g-1', 'g-2', 'g-3'],
      consolidated_content: '# Merged gotchas',
      observation_type: 'gotcha',
      tags: ['sqlite'],
      reason: 'Three SQLite gotchas',
    }, client);

    expect(result.status).toBe('consolidated');
    expect(result.new_spore_id).toBe('gotcha-newwisdom');
    expect(result.sources_superseded).toEqual(['g-1', 'g-2', 'g-3']);
    expect(client.post).toHaveBeenCalledWith('/api/mcp/consolidate', {
      source_spore_ids: ['g-1', 'g-2', 'g-3'],
      consolidated_content: '# Merged gotchas',
      observation_type: 'gotcha',
      tags: ['sqlite'],
      reason: 'Three SQLite gotchas',
    });
  });

  it('forwards undefined optional fields rather than fabricating them', async () => {
    const client = mockClient({
      new_spore_id: 'decision-xyz',
      sources_superseded: ['d-1', 'd-2'],
      status: 'consolidated',
      created_at: 1700000000,
    });

    await handleMycoConsolidate({
      source_spore_ids: ['d-1', 'd-2'],
      consolidated_content: 'merged',
      observation_type: 'decision',
    }, client);

    expect(client.post).toHaveBeenCalledWith('/api/mcp/consolidate', {
      source_spore_ids: ['d-1', 'd-2'],
      consolidated_content: 'merged',
      observation_type: 'decision',
      tags: undefined,
      reason: undefined,
    });
  });

  it('throws on daemon failure', async () => {
    const client = mockClient(null, false);
    await expect(handleMycoConsolidate({
      source_spore_ids: ['a', 'b'],
      consolidated_content: 'x',
      observation_type: 'gotcha',
    }, client)).rejects.toThrow('Failed to consolidate');
  });
});
