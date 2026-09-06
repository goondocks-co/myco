import { afterEach, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { reconcileEmbedding } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { EmbeddingUnavailable, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { searchProject } from '../../packages/myco-server/src/read/search.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';
import { setPlanStatus } from '../../packages/myco-server/src/read/plans.js';

configureSqliteLibrary();
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  insert('projects', { project_id: 'p', name: 'project', created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  insert('sessions', { project_id: 'p', session_id: 's', machine_id: 'm', created_by_token_id: 't', first_received_at: 1, last_received_at: 1, title: 'an unsummarized session' });
  const spore = (id: string, content: string) => insert('spores', { project_id: 'p', id, agent_id: 'a', content, observation_type: 'decision', created_at: 1 });
  const calls: string[] = [];
  const provider: EmbeddingProvider = { modelKey: 'test-model', embed: async (text) => { calls.push(text); return text.includes('unrelated') ? [0, 1] : [1, 0]; } };
  const vectors = sqliteVectorStore(f.sqlite);
  const context = { db: f.db, blobs: f.bucket, vectors, provider };
  const search = (query: string, mode = 'semantic') => searchProject(f.db, { projectId: 'p' }, { query, mode }, async () => ({ provider: context.provider, vectors }));
  const step = (now = 1000) => reconcileEmbedding(context, 'p', now);
  return { ...f, spore, calls, provider, context, search, step, insert };
}

test('plan status writes report their own result and invalidate indexed metadata', async () => {
  const f = fixture();
  f.insert('plans', { project_id: 'p', plan_key: 'plan', session_id: 's', event_id: 'e', machine_id: 'm', title: 'architecture', content: 'a plan', content_hash: 'hash', status: 'active', created_at: 1, updated_at: 1, token_id: 't', received_at: 1 });
  await f.step();
  expect((await f.search('architecture')).results).toHaveLength(1);
  expect(await setPlanStatus(f.db, { projectId: 'p' }, 'plan', 'completed', 'operator', 2)).toBe(true);
  expect((await f.search('architecture')).results).toEqual([]);
  expect(await setPlanStatus(f.db, { projectId: 'p' }, 'plan', 'completed', 'operator', 3)).toBe(false);
  expect((await f.step()).phase).toBe('stale');
  expect((await f.search('architecture')).results).toHaveLength(1);
});

test('indexes summaries only, invalidates source edits immediately and reconciles a changed model', async () => {
  const f = fixture();
  f.spore('one', 'a durable decision');
  expect(await f.step()).toEqual({ phase: 'missing', processed: 1 });
  expect(f.calls).toHaveLength(1);
  expect((await f.search('architecture')).results.map((r) => r.id)).toEqual(['one']);
  f.sqlite.query("UPDATE spores SET content = 'unrelated decision' WHERE id = 'one'").run();
  expect((await f.search('architecture')).results).toEqual([]);
  expect(await f.step()).toEqual({ phase: 'stale', processed: 1 });
  expect((await f.search('architecture')).results).toEqual([]);
  f.context.provider = { ...f.provider, modelKey: 'model-two' };
  expect((await f.search('unrelated')).results).toEqual([]);
  expect(await f.step()).toEqual({ phase: 'stale', processed: 1 });
  expect((await f.search('unrelated')).results.map((r) => r.id)).toEqual(['one']);
  expect((await f.step()).phase).toBe('orphans');
  expect((await f.step()).phase).toBe('orphans');
  expect((await f.step()).phase).toBe('settled');
});

test('does not fall back after zero semantic matches; reports only provider unavailability as fallback', async () => {
  const f = fixture();
  f.spore('one', 'unrelated architecture');
  await f.step();
  const zero = await f.search('architecture', 'auto');
  expect(zero).toMatchObject({ mode: 'semantic', provider_unavailable: false, results: [] });
  f.context.provider = { modelKey: f.provider.modelKey, embed: async () => { throw new EmbeddingUnavailable('offline'); } };
  expect(await f.search('architecture', 'auto')).toMatchObject({ mode: 'fts', provider_unavailable: true, results: [{ id: 'one' }] });
  expect(await f.search('architecture', 'semantic')).toMatchObject({ mode: 'semantic', provider_unavailable: true, results: [] });
  f.context.provider = { modelKey: f.provider.modelKey, embed: async () => { throw new Error('invalid vector'); } };
  await expect(f.search('architecture', 'auto')).rejects.toThrow('invalid vector');
});

test('a status change during the provider call never publishes an eligible vector and is swept', async () => {
  const f = fixture();
  f.spore('one', 'architecture');
  f.context.provider = { ...f.provider, embed: async () => {
    f.sqlite.query("UPDATE spores SET status = 'superseded' WHERE id = 'one'").run();
    return [1, 0];
  } };
  await f.step();
  expect((await f.search('architecture')).results).toEqual([]);
  expect((await f.step()).phase).toBe('orphans');
  expect(f.sqlite.query('SELECT COUNT(*) AS n FROM local_vectors').get()).toEqual({ n: 0 });
  expect((await f.step()).phase).toBe('settled');
});

test('journals interrupted writes and advances fairly to the next namespace before retrying', async () => {
  const f = fixture();
  f.sqlite.query("UPDATE sessions SET summary = 'session summary' WHERE session_id = 's'").run();
  f.spore('one', 'spore decision');
  f.context.provider = { ...f.provider, embed: async () => { throw new EmbeddingUnavailable('offline'); } };
  await expect(f.step()).rejects.toThrow('offline');
  expect(f.sqlite.query('SELECT type, ready FROM embedding_receipts').all()).toEqual([{ type: 'session', ready: 0 }]);
  f.context.provider = f.provider;
  await f.step();
  expect(f.calls[0]).toContain('spore decision');
  await f.step();
  expect(f.calls[1]).toContain('session summary');
  expect((await f.search('decision')).results.map((r) => r.type).sort()).toEqual(['session', 'spore']);
});

test('resumes paginated hubness work, waits for vector visibility, and restarts when the corpus grows', async () => {
  const f = fixture();
  for (let i = 0; i < 52; i++) f.spore(`spore-${i}`, i < 26 ? 'architecture' : 'unrelated');
  for (let i = 0; i < 52; i++) expect((await f.step()).phase).toBe('missing');
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(true);
  const native = f.context.vectors;
  f.context.vectors = { ...native, get: async () => [] };
  expect(await f.step()).toEqual({ phase: 'visibility', processed: 0 });
  expect(f.sqlite.query('SELECT * FROM embedding_hubness_work').all()).toEqual([]);
  f.context.vectors = native;
  expect((await f.step()).phase).toBe('hubness');
  expect(f.sqlite.query('SELECT count FROM embedding_hubness_work').get()).toEqual({ count: expect.any(Number) });
  let settled = false;
  for (let i = 0; i < 110; i++) {
    if ((await f.step()).phase === 'settled') { settled = true; break; }
  }
  expect(settled).toBe(true);
  const receipts = f.sqlite.query('SELECT neighbor_mean, neighbor_std FROM embedding_receipts WHERE ready = 1').all() as Array<{ neighbor_mean: number; neighbor_std: number }>;
  expect(receipts).toHaveLength(52);
  const mean = 26 / 51;
  for (const r of receipts) {
    expect(r.neighbor_mean).toBeCloseTo(mean, 6);
    expect(r.neighbor_std).toBeCloseTo(Math.sqrt(mean * (1 - mean)), 6);
  }
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(false);
  f.spore('new-spore', 'architecture');
  await f.step();
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(true);
  expect((await f.step()).phase).toBe('hubness');
  expect(f.sqlite.query('SELECT hubness_count, hubness_target_count FROM embedding_cursors').get()).toEqual({ hubness_count: null, hubness_target_count: 53 });
});
