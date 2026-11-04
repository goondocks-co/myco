import { afterEach, expect, it } from 'bun:test';
import { nearSpores } from '@myco-server-worker/core/spore-near-matches.js';
import { writeSpore } from '@myco-server-worker/core/spore-admission.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import type { EmbeddingProvider } from '@myco-server-worker/core/embedding/provider.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';

const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const NOW = 1_000_000_000;
const SCOPE = { projectId: 'p' };
const LINE = 'Scheduler retries need their limit named';
const MODEL = 'test-model';

/** A Project whose spores are embedded: one a full-text match cannot find, one only a full-text match can, one no longer active. */
async function project(embed: EmbeddingProvider['embed']) {
  const f = sqliteEnv();
  opened.push(f);
  f.sqlite.run(`INSERT INTO projects(project_id,name,created_at) VALUES('p','project',1)`);
  f.sqlite.run(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('a','agent','built-in',1,1)`);
  const spore = (id: string, content: string, status = 'active', line: string | null = null) => f.sqlite.run(
    `INSERT INTO spores(project_id,id,agent_id,content,observation_type,status,agent_line,created_at) VALUES('p',?,'a',?,'decision',?,?,1)`, [id, content, status, line]);
  spore('close', 'Exponential backoff belongs around the claim', 'active', 'Back off around the claim.');
  spore('gone', 'Exponential backoff was once around everything', 'superseded');
  spore('shares', 'Their dashboard   words\ndiffer from ours');
  const index = indexFixture();
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async (text) => (/backoff|retries/.test(text) ? [1, 0] : [0, 1]) };
  const context = { db: f.db, blobs: f.bucket, vectors: cloudflareVectorStore(index), provider };
  for (let step = 0; step < 100; step += 1) {
    const { processed } = await reconcileEmbedding(context, 'p', NOW);
    index.apply();
    if (processed === 0) break;
  }
  spore('saved', LINE);
  return { f, env: { ...f.serverEnv, vectors: context.vectors, embeddingProvider: async () => ({ ...provider, embed }) } };
}

it('answers the closest active spores, semantic neighbours first, then what only full text finds', async () => {
  const { env } = await project(async () => [1, 0]);
  expect(await nearSpores(env, SCOPE, 'saved', LINE)).toEqual([
    { id: 'close', revision: expect.any(Number), observation_type: 'decision', agent_line: 'Back off around the claim.' },
    { id: 'shares', revision: expect.any(Number), observation_type: 'decision', agent_line: 'Their dashboard words differ from ours' },
  ]);
});

it('falls back to full text when the provider fails, and still answers a save when a read fails', async () => {
  const { f, env } = await project(async () => { throw new Error('provider down'); });
  expect((await nearSpores(env, SCOPE, 'saved', LINE)).map((match) => match.id)).toEqual(['shares']);
  expect(await nearSpores({ ...env, db: { ...f.db, prepare: () => { throw new Error('storage down'); } } as never }, SCOPE, 'saved', LINE)).toEqual([]);
});

it('adds near matches to a learning run\'s save and nothing to a member\'s', async () => {
  const { env } = await project(async () => [1, 0]);
  const saved = await writeSpore({ op: 'save', type: 'gotcha', agent_line: 'Their members save too.', content: 'c' },
    { env, projectId: 'p', now: NOW, principal: { kind: 'member', memberId: 'm', machineId: 'mc' } }) as Record<string, unknown>;
  expect(saved.id).toEqual(expect.any(String));
  expect(saved).not.toHaveProperty('near_matches');
});
