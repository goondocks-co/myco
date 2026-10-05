import { DIAGNOSTIC_PAYLOADS } from '../helpers/secret-corpus.ts';
import { afterEach, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { reconcileEmbedding, resetEmbeddingIndex } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { EmbeddingUnavailable, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { searchProject } from '../../packages/myco-server/src/read/search.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';
import { tombstoneSession } from '../../packages/myco-server/src/core/tombstones.js';
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

test('deleted sessions are hidden by both searches while saved knowledge remains, then their vectors are reclaimed', async () => {
  const f = fixture();
  f.sqlite.run("UPDATE sessions SET title='architecture', summary='architecture summary' WHERE project_id='p' AND session_id='s'");
  f.spore('kept', 'architecture decision');
  f.sqlite.run("UPDATE spores SET session_id='s' WHERE project_id='p' AND id='kept'");
  for (let i = 0; i < 4; i++) await f.step();
  for (const mode of ['semantic', 'fts']) expect((await f.search('architecture', mode)).results.map((r) => r.id).sort()).toEqual(['kept', 's']);
  f.insert('session_tombstones', { project_id: 'p', session_id: 's', created_at: 2, created_by: 'operator' });
  for (const mode of ['semantic', 'fts']) expect((await f.search('architecture', mode)).results.map((r) => r.id)).toEqual(['kept']);
  await tombstoneSession(f.serverEnv, { projectId: 'p' }, 's', 'operator', 3);
  for (let i = 0; i < 4; i++) await f.step();
  expect(f.sqlite.query("SELECT metadata_json FROM local_vectors WHERE project_id='p'").all()).toHaveLength(1);
  expect((await f.search('architecture')).results.map((r) => r.id)).toEqual(['kept']);
});

test('rebuilds a recovered empty index without changing source knowledge or another project', async () => {
  const f = fixture();
  f.spore('one', 'durable architecture');
  f.spore('two', 'unrelated observation');
  for (let i = 0; i < 6; i++) await f.step();
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(false);
  const sources = f.sqlite.query('SELECT * FROM spores ORDER BY id').all();
  const versions = f.sqlite.query('SELECT project_id, type, record_id, revision FROM embedding_versions ORDER BY record_id').all();
  f.sqlite.run("INSERT INTO embedding_cursors(project_id,hubness_model,hubness_count) VALUES ('proj_1','other-model',4)");
  f.sqlite.run("DELETE FROM local_vectors WHERE project_id = 'p'");
  expect((await f.search('architecture')).results).toEqual([]);
  expect(await f.step()).toEqual({ phase: 'settled', processed: 0 });
  await resetEmbeddingIndex(f.db, 'p');
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 2000)).toBe(true);
  await resetEmbeddingIndex(f.db, 'p');
  for (let i = 0; i < 6; i++) await f.step(2000);
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 2000)).toBe(false);
  expect((await f.search('architecture')).results.map((row) => row.id)).toEqual(['one']);
  expect(f.sqlite.query('SELECT * FROM spores ORDER BY id').all()).toEqual(sources);
  expect(f.sqlite.query('SELECT project_id, type, record_id, revision FROM embedding_versions ORDER BY record_id').all()).toEqual(versions);
  expect(f.sqlite.query("SELECT hubness_model,hubness_count FROM embedding_cursors WHERE project_id='proj_1'").get())
    .toEqual({ hubness_model: 'other-model', hubness_count: 4 });
});

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

test('calibrates in bounded operations, waits for vector visibility, and takes a new spore in without recomputing every pair', async () => {
  const f = fixture();
  for (let i = 0; i < 52; i++) f.spore(`spore-${i}`, i < 26 ? 'architecture' : 'unrelated');
  for (let i = 0; i < 52; i++) expect((await f.step()).phase).toBe('missing');
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(true);
  const native = f.context.vectors;
  f.context.vectors = { ...native, get: async () => [] };
  expect(await f.step()).toEqual({ phase: 'visibility', processed: 0 });
  expect(f.sqlite.query('SELECT * FROM embedding_hubness_members').all()).toEqual([]);
  f.context.vectors = native;
  // Operations of 20 spores join over 0, 20 and 40 settled members: one page each.
  expect(await f.step()).toEqual({ phase: 'hubness', processed: 1 });
  expect(f.sqlite.query('SELECT state, COUNT(*) AS n FROM embedding_hubness_members GROUP BY state').all()).toEqual([{ state: 0, n: 20 }]);
  expect(await f.step()).toEqual({ phase: 'hubness', processed: 1 });
  expect(await f.step()).toEqual({ phase: 'hubness', processed: 1 });
  expect(await f.step()).toEqual({ phase: 'settled', processed: 0 });
  const stats = () => f.sqlite.query(`SELECT r.neighbor_mean, r.neighbor_std, s.content FROM embedding_receipts r
    JOIN spores s ON s.project_id = r.project_id AND s.id = r.record_id WHERE r.ready = 1`).all() as Array<{ neighbor_mean: number; neighbor_std: number; content: string }>;
  expect(stats()).toHaveLength(52);
  for (const r of stats()) {
    expect(r.neighbor_mean).toBeCloseTo(26 / 51, 9);
    expect(r.neighbor_std).toBeCloseTo(Math.sqrt((26 / 51) * (25 / 51)), 9);
  }
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(false);
  f.spore('new-spore', 'architecture');
  expect((await f.step()).phase).toBe('missing');
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(true);
  expect(await f.step()).toEqual({ phase: 'hubness', processed: 1 });
  expect(f.sqlite.query('SELECT hubness_count, hubness_cursor FROM embedding_cursors').get()).toEqual({ hubness_count: 52, hubness_cursor: expect.any(String) });
  expect(await f.step()).toEqual({ phase: 'hubness', processed: 1 });
  expect(await f.step()).toEqual({ phase: 'settled', processed: 0 });
  expect(f.sqlite.query('SELECT hubness_count, hubness_cursor FROM embedding_cursors').get()).toEqual({ hubness_count: 53, hubness_cursor: null });
  for (const r of stats()) {
    const mean = r.content === 'architecture' ? 26 / 52 : 27 / 52;
    expect(r.neighbor_mean).toBeCloseTo(mean, 9);
    expect(r.neighbor_std).toBeCloseTo(Math.sqrt(mean * (1 - mean)), 9);
  }
  expect(await hasEmbeddingWork(f.db, 'p', f.provider.modelKey, 1000)).toBe(false);
});

for (const leak of DIAGNOSTIC_PAYLOADS) {
  test(`source failure storage omits ${leak.name} and retains the HTTP status`, async () => {
    const f = fixture();
    f.spore('refused', 'source knowledge');
    f.context.provider = { ...f.provider, embed: async () => { throw new EmbeddingUnavailable('failed', { kind: 'http', status: 400, retryAfterMs: null, detail: leak.command }); } };
    expect(await f.step()).toEqual({ phase: 'passed-over', processed: 1 });
    const stored = JSON.stringify(f.sqlite.query('SELECT reason FROM embedding_source_failures').all());
    expect(stored).toContain('HTTP 400');
    for (const secret of leak.secrets) expect(stored).not.toContain(secret);
    expect(await f.step()).toEqual({ phase: 'settled', processed: 0 });
  });
}
