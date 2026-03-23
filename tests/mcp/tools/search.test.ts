/**
 * Tests for myco_search tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoSearch } from '@myco/mcp/tools/search.js';
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

  it('returns results from daemon response', async () => {
    const mockResults = [
      { id: 'spore-1', type: 'spores', content: 'test', score: 0.9 },
    ];
    const client = mockClient({ mode: 'semantic', results: mockResults });
    const results = await handleMycoSearch({ query: 'test' }, client);
    expect(results).toEqual(mockResults);
  });

  it('returns empty on daemon failure', async () => {
    const client = mockClient(null, false);
    const results = await handleMycoSearch({ query: 'test' }, client);
    expect(results).toEqual([]);
  });
});
