/**
 * Tests for myco_search tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSearch } from '@myco/tools/search.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_search', () => {
  it('returns empty results when daemon returns no results', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    const results = await handleMycoSearch({ query: 'auth middleware' }, client);
    expect(results).toEqual([]);
  });

  it('passes query and limit to daemon endpoint', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    await handleMycoSearch({ query: 'auth', limit: 5 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('/api/search'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('q=auth'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
  });

  it('passes type filter to daemon endpoint', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    await handleMycoSearch({ query: 'auth', type: 'spore' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('type=spore'));
  });

  it('forces semantic mode when semantic-only filters are present', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    await handleMycoSearch({ query: 'auth', observation_type: 'decision' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('mode=semantic'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('observation_type=decision'));
  });

  it('returns results from daemon response', async () => {
    const mockResults = [
      { id: 'spore-1', type: 'spores', content: 'test', score: 0.9 },
    ];
    const client = mockClient({ mode: 'semantic', results: mockResults });
    const results = await handleMycoSearch({ query: 'test' }, client);
    expect(results).toEqual([{
      ...mockResults[0],
      type: 'spore',
      title: 'spore-1',
      preview: 'test',
      retrieve: { tool: 'myco_spores', input: { op: 'get', id: 'spore-1' } },
    }]);
  });

  it('throws on daemon failure instead of silently returning empty', async () => {
    const client = mockClient(null, false);
    await expect(handleMycoSearch({ query: 'test' }, client)).rejects.toThrow();
  });

  it('surfaces the daemon error message on a tenancy violation', async () => {
    const client = mockClient(
      { error: { code: 'tenancy-violation', message: 'Rejected request with invalid tenancy' } },
      false,
    );
    await expect(handleMycoSearch({ query: 'test' }, client)).rejects.toThrow(/tenancy/i);
  });

  it('still returns [] for a genuine empty result set (ok, no matches)', async () => {
    const client = mockClient({ mode: 'semantic', results: [] }, true);
    const results = await handleMycoSearch({ query: 'no-such-thing' }, client);
    expect(results).toEqual([]);
  });
});
