import { expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { cloudflareEmbeddingProvider } from '../../packages/myco-server/src/platform/cloudflare/embedding.js';
import { dispatchEmbeddingWork, embeddingKeepsAwake } from '../../packages/myco-server/src/core/embedding/jobs.js';
import { settingsWriter } from '../../packages/myco-server/src/core/settings.js';
import type { ServerEnv } from '../../packages/myco-server/src/core/adapters.js';

test('embedding backlog dispatches once without LLM credentials and respects the idle setting', async () => {
  const f = sqliteEnv();
  try {
    const now = Date.now(), launched: string[] = [];
    f.sqlite.query("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,?)").run(now);
    f.sqlite.query("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('proj_1','spore','myco-agent','project architecture','decision',?)").run(now);
    const env: ServerEnv = { ...f.serverEnv, origin: 'https://myco.example', vectors: cloudflareVectorStore(indexFixture()),
      embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }),
      harnessLaunch: async (spec) => { launched.push(spec.runId); },
    };
    expect(await embeddingKeepsAwake(env, now)).toBe(true);
    const attempts = await Promise.all([dispatchEmbeddingWork(env, now), dispatchEmbeddingWork(env, now)]);
    expect(attempts.reduce((a, b) => a + b)).toBe(1);
    expect(launched).toHaveLength(1);
    expect(f.sqlite.query('SELECT task, provider, project_id FROM agent_runs').all()).toEqual([{ task: 'embedding-reconcile', provider: 'embedding', project_id: 'proj_1' }]);
    expect(await dispatchEmbeddingWork(env, now + 60_000)).toBe(0);
    await settingsWriter(f.db).setLeaf('embedding.prevent_deep_sleep', false, 'operator', now);
    expect(await embeddingKeepsAwake(env, now)).toBe(false);
    expect(await dispatchEmbeddingWork({ ...env, embeddingProvider: async () => null }, now)).toBe(0);
  } finally { f.sqlite.close(); }
});
