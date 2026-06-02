import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSearchHandler } from '@myco/daemon/api/search.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
function makeRequest(query: Record<string, string>, requestContext?: MycoRequestContext): RouteRequest {
  // When the test doesn't provide a custom request context, default to the
  // shared TEST_REQUEST_CONTEXT but blank its databasePath so the search
  // handler falls back to the singleton via getDatabase(). Tests that
  // explicitly pass a custom requestContext (e.g. seeded.requestContext)
  // keep their real per-Grove DB path so the per-request open path is
  // exercised correctly.
  const ctx = requestContext ?? { ...TEST_REQUEST_CONTEXT, databasePath: '' };
  return { body: {}, query, params: {}, pathname: '/api/search', requestContext: ctx } as RouteRequest;
}

function fakeEmbeddingManager(): EmbeddingManager {
  return {
    embedQuery: async () => Array(8).fill(0.5),
    searchVectors: () => [],
  } as Pick<EmbeddingManager, 'embedQuery' | 'searchVectors'> as EmbeddingManager;
}

function seedSearchDb(projectId: string): { tempDir: string; dbPath: string; requestContext: MycoRequestContext } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-search-api-'));
  const projectVaultDir = path.join(tempDir, '.myco');
  fs.mkdirSync(projectVaultDir, { recursive: true });
  const dbPath = path.join(projectVaultDir, 'myco.db');
  const db = openDatabase(dbPath);
  try {
    createSchema(db, 'machine-test');
    db.prepare(
      `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
    ).run('agent-test', 'Test Agent', 1);
    db.prepare(
      `INSERT INTO spores (
         id, project_id, agent_id, observation_type, status, content, created_at, machine_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'spore-context',
      projectId,
      'agent-test',
      'decision',
      'active',
      'Request context package result',
      2,
      'machine-test',
    );
  } finally {
    db.close();
  }
  return {
    tempDir,
    dbPath,
    requestContext: {
      projectRoot: tempDir,
      projectId,
      groveId: 'grove-context',
      machineId: 'machine-test',
      sessionId: null,
      projectVaultDir,
      databasePath: dbPath,
      source: 'headers',
      // Explicit project/grove context = caller-asserted tenancy; the scope
      // seam binds it to project scope only when caller-asserted.
      tenancySource: 'caller',
    },
  };
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

  it('runs FTS against the request context database', async () => {
    const seeded = seedSearchDb('project-context');
    try {
      const handler = createSearchHandler({ embeddingManager: fakeEmbeddingManager() });

      const res = await handler(makeRequest({
        q: 'package',
        type: 'spore',
        mode: 'fts',
      }, seeded.requestContext));

      expect(res.body?.results).toEqual([
        expect.objectContaining({
          id: 'spore-context',
          type: 'spore',
          preview: 'Request context package result',
        }),
      ]);
    } finally {
      fs.rmSync(seeded.tempDir, { recursive: true, force: true });
    }
  });

  it('hydrates semantic results from the request context database', async () => {
    const seeded = seedSearchDb('project-context');
    try {
      let resolvedContext: MycoRequestContext | undefined;
      const handler = createSearchHandler({
        embeddingManager: fakeEmbeddingManager(),
        resolveEmbeddingManager: (requestContext) => {
          resolvedContext = requestContext;
          return {
            embedQuery: async () => Array(8).fill(0.5),
            searchVectors: () => [
              {
                id: 'spore-context',
                namespace: 'spores',
                similarity: 0.9,
                metadata: { project_id: 'project-context' },
              },
            ],
          };
        },
      });

      const res = await handler(makeRequest({
        q: 'package',
        type: 'spore',
        mode: 'semantic',
      }, seeded.requestContext));

      expect(resolvedContext?.groveId).toBe('grove-context');
      expect(res.body?.results).toEqual([
        expect.objectContaining({
          id: 'spore-context',
          type: 'spore',
          preview: 'Request context package result',
          source: 'local',
        }),
      ]);
    } finally {
      fs.rmSync(seeded.tempDir, { recursive: true, force: true });
    }
  });
});
