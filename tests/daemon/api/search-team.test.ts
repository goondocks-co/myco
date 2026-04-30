import { describe, expect, it } from 'bun:test';
import { createSearchHandler } from '@myco/daemon/api/search.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { RouteRequest } from '@myco/daemon/router.js';

function makeRequest(query: Record<string, string>): RouteRequest {
  return { body: {}, query, params: {}, pathname: '/api/search' } as RouteRequest;
}

function fakeEmbeddingManager(): EmbeddingManager {
  return {
    embedQuery: async () => Array(8).fill(0.5),
    searchVectors: () => [],
  } as Pick<EmbeddingManager, 'embedQuery' | 'searchVectors'> as EmbeddingManager;
}

describe('GET /api/search team results', () => {
  it('normalizes team table_name results with retrieve hints', async () => {
    const handler = createSearchHandler({
      embeddingManager: fakeEmbeddingManager(),
      getTeamClient: () => ({
        search: async () => ({
          results: [
            {
              id: 'spore-remote',
              table_name: 'spores',
              content: 'team spore',
              score: 0.92,
              machine_id: 'remote-machine',
            },
          ],
          machine_ids: ['remote-machine'],
        }),
      }) as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ q: 'team spore', mode: 'semantic' }));

    expect(res.body?.results).toEqual([
      expect.objectContaining({
        id: 'spore-remote',
        type: 'spore',
        preview: 'team spore',
        source: 'team:remote-machine',
        retrieve: { tool: 'myco_spores', input: { op: 'get', id: 'spore-remote' } },
      }),
    ]);
  });
});
