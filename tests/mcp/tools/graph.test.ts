/**
 * Tests for myco_graph tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoGraph } from '@myco/mcp/tools/graph.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_graph', () => {
  it('returns empty results for unknown note', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoGraph({ note_id: 'nonexistent' }, client);
    expect(result.note_id).toBe('nonexistent');
    expect(result.edges).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('passes direction parameter to daemon', async () => {
    const client = mockClient({ center: {}, nodes: [], edges: [], depth: 1 });
    await handleMycoGraph({ note_id: 'test-note', direction: 'outgoing' }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('direction=outgoing'));
  });

  it('passes depth parameter to daemon', async () => {
    const client = mockClient({ center: {}, nodes: [], edges: [], depth: 2 });
    await handleMycoGraph({ note_id: 'test-note', depth: 2 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('depth=2'));
  });

  it('maps daemon response to expected shape', async () => {
    const client = mockClient({
      center: { id: 'e1', type: 'concept', name: 'Auth' },
      nodes: [{ id: 'e2', type: 'concept', name: 'JWT' }],
      edges: [{ source_id: 'e1', target_id: 'e2', type: 'related', confidence: 0.8 }],
      depth: 1,
    });
    const result = await handleMycoGraph({ note_id: 'test-note' }, client);
    expect(result.note_id).toBe('test-note');
    expect(result.entities).toEqual([{ id: 'e2', type: 'concept', name: 'JWT' }]);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].source_id).toBe('e1');
  });
});
