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

test('keeps one embedding run in flight across the Deployment: the next Project waits for it to close', async () => {
  const f = sqliteEnv();
  try {
    const now = Date.now(), launched: string[] = [];
    f.sqlite.query("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,?)").run(now);
    f.sqlite.query("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_2','two',?)").run(now);
    for (const project of ['proj_1', 'proj_2']) {
      f.sqlite.query("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES(?,'spore','myco-agent','project architecture','decision',?)").run(project, now);
    }
    const env: ServerEnv = { ...f.serverEnv, origin: 'https://myco.example', vectors: cloudflareVectorStore(indexFixture()),
      embeddingProvider: async () => cloudflareEmbeddingProvider({ run: async () => ({ data: [[1, 0]] }) }),
      harnessLaunch: async (spec) => { launched.push(spec.runId); },
    };
    const runs = () => f.sqlite.query("SELECT project_id FROM agent_runs WHERE task = 'embedding-reconcile' ORDER BY started_at, project_id").all();
    expect(await dispatchEmbeddingWork(env, now)).toBe(1);
    expect(runs()).toEqual([{ project_id: 'proj_1' }]);
    // A chained tick while that run is still in flight starts nothing, for this Project or another.
    expect(await dispatchEmbeddingWork(env, now + 2_000)).toBe(0);
    expect(await dispatchEmbeddingWork(env, now + 120_000)).toBe(0);
    expect(launched).toHaveLength(1);
    f.sqlite.query("UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE task = 'embedding-reconcile'").run(now + 130_000);
    expect(await dispatchEmbeddingWork(env, now + 140_000)).toBe(1);
    expect(runs()).toEqual([{ project_id: 'proj_1' }, { project_id: 'proj_2' }]);
  } finally { f.sqlite.close(); }
});
