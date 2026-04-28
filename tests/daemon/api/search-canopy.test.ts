/**
 * Tests for the daemon `/api/search` canopy branch.
 *
 * `type=canopy` routes through the embedding manager's `searchVectors` pinned
 * to the `canopy_entries` namespace and hydrates each row with
 * `llm_description` straight from the canopy_entries table. This is the
 * server-side counterpart to the harness `vault_search_canopy` tool — same
 * shape, same hydration, exposed over HTTP for the MCP `myco_search` proxy.
 *
 * Canopy is local-only — no team-search merge, mirroring the harness tool.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db';
import { createSearchHandler } from '@myco/daemon/api/search.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { RouteRequest } from '@myco/daemon/router.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function seedCanopyRow(opts: {
  project_id: string;
  path: string;
  language?: string | null;
  description: string;
}): void {
  const now = epochNow();
  seedCanopyEntry(getDatabase(), {
    project_id: opts.project_id,
    path: opts.path,
    size_bytes: 100,
    token_estimate: 20,
    line_count: 10,
    language: opts.language ?? null,
    mechanical_updated_at: now,
    llm_description: opts.description,
    llm_updated_at: now,
    embedded: 1,
  });
}

function makeRequest(query: Record<string, string>): RouteRequest {
  return { body: {}, query, params: {}, pathname: '/api/search' } as RouteRequest;
}

function fakeEmbeddingManager(overrides: Partial<EmbeddingManager> = {}): EmbeddingManager {
  return {
    embedQuery: async () => Array(8).fill(0.5),
    searchVectors: () => [],
    ...overrides,
  } as Pick<EmbeddingManager, 'embedQuery' | 'searchVectors'> as EmbeddingManager;
}

describe('GET /api/search type=canopy', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('routes type=canopy to the canopy_entries namespace', async () => {
    seedCanopyRow({ project_id: 'p', path: 'auth/login.ts', language: 'typescript', description: 'login flow handler' });

    let capturedNamespace: string | undefined;
    const embeddingManager = fakeEmbeddingManager({
      searchVectors: ((_q: number[], opts?: { namespace?: string }) => {
        capturedNamespace = opts?.namespace;
        return [
          {
            id: 'p:auth/login.ts',
            namespace: 'canopy_entries',
            similarity: 0.9,
            metadata: { project_id: 'p', path: 'auth/login.ts', language: 'typescript' },
          },
        ];
      }) as EmbeddingManager['searchVectors'],
    });

    const handler = createSearchHandler({ embeddingManager });
    const res = await handler(makeRequest({ q: 'auth', type: 'canopy' }));

    expect(capturedNamespace).toBe('canopy_entries');
    expect(res.body?.results).toHaveLength(1);
    expect(res.body?.results[0]).toMatchObject({
      project_id: 'p',
      path: 'auth/login.ts',
      llm_description: 'login flow handler',
      language: 'typescript',
    });
    expect(typeof res.body?.results[0].score).toBe('number');
  });

  it('hydrates llm_description from canopy_entries rather than vector metadata', async () => {
    seedCanopyRow({ project_id: 'p', path: 'auth/login.ts', language: 'typescript', description: 'CURRENT description from row' });

    const embeddingManager = fakeEmbeddingManager({
      searchVectors: (() => [
        {
          id: 'p:auth/login.ts',
          namespace: 'canopy_entries',
          similarity: 0.9,
          // Vector metadata intentionally OMITS llm_description; hydration must
          // pull it straight from the canopy_entries row.
          metadata: { project_id: 'p', path: 'auth/login.ts', language: 'typescript' },
        },
      ]) as EmbeddingManager['searchVectors'],
    });

    const handler = createSearchHandler({ embeddingManager });
    const res = await handler(makeRequest({ q: 'auth', type: 'canopy' }));
    expect(res.body?.results[0].llm_description).toBe('CURRENT description from row');
  });

  it('returns null llm_description when the canopy_entries row is missing', async () => {
    const embeddingManager = fakeEmbeddingManager({
      searchVectors: (() => [
        {
          id: 'p:ghost.ts',
          namespace: 'canopy_entries',
          similarity: 0.7,
          metadata: { project_id: 'p', path: 'ghost.ts', language: 'typescript' },
        },
      ]) as EmbeddingManager['searchVectors'],
    });

    const handler = createSearchHandler({ embeddingManager });
    const res = await handler(makeRequest({ q: 'ghost', type: 'canopy' }));
    expect(res.body?.results).toHaveLength(1);
    expect(res.body?.results[0].llm_description).toBeNull();
  });

  it('returns provider_unavailable when the embedding provider yields null', async () => {
    const embeddingManager = fakeEmbeddingManager({
      embedQuery: (async () => null) as EmbeddingManager['embedQuery'],
    });

    const handler = createSearchHandler({ embeddingManager });
    const res = await handler(makeRequest({ q: 'x', type: 'canopy' }));
    expect(res.body?.results).toEqual([]);
    expect(res.body?.provider_unavailable).toBe(true);
  });
});
