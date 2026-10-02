/**
 * Switch embedding model, on both targets through their shipped env and request handler: search keeps answering by
 * meaning at every step while the new model's vectors are built, reconcile retires neither model's vectors meanwhile,
 * search moves only once every source (one added meanwhile included) holds a vector under the new model, a cancel
 * leaves search on its model and retires the partial vectors, a restart resumes, a failure of the new model pauses the
 * switch with its reason, and a model larger than search stores stays refused.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { advanceEmbedding } from '@myco-server-worker/core/embedding/step.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { embeddingWorkPlan } from '@myco-server-worker/core/embedding/switch.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { VECTOR_DELETE_CONFIRM_MS } from '@myco-server-worker/core/embedding/provider.js';
import type { EmbeddingSwitchStatus } from '@goondocks/myco-shared/settings-contract';
import { seededSqlite } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { asOwner, asOwnerPost, asOwnerPut, ownerCookie, OWNER_ENV } from './helpers/owner.js';

configureSqliteLibrary();
const WRAP = btoa('e'.repeat(32));
const PROJECT = 'proj_1';
const temporary: string[] = [];
const stops: Array<() => void> = [];
afterAll(() => { for (const stop of stops) stop(); for (const dir of temporary) rmSync(dir, { recursive: true, force: true }); });

/** A vector of `dimensions` that points one way for text about architecture and another for anything else. */
function vectorFor(text: string, dimensions: number): number[] {
  const about = text.includes('architecture');
  return Array.from({ length: dimensions }, (_, i) => i === 0 ? (about ? 1 : 0) : i === 1 ? (about ? 0 : 1) : i === 2 ? 0.05 : 0);
}

/** What each target's models answer, and which of them fail. */
interface Models { failing: Map<string, number>; calls: Map<string, number> }

interface Target {
  name: 'hosted' | 'self-hosted';
  sqlite: Database;
  env(): ServerEnv;
  fetch(request: Request): Promise<Response>;
  models: Models;
  /** The model search starts with, and two to switch to: one of the same size and one of another. */
  start: { provider: string; model: string; endpoint?: string };
  sameSize: { provider: string; model: string; endpoint?: string };
  otherSize: { provider: string; model: string; endpoint?: string };
  vectorsHeld(modelKey: string): Promise<number>;
  /** Make the next vector write fail, as a process that dies mid-step does. */
  breakNextWrite(): void;
}

const DIMENSIONS: Record<string, number> = {
  '@cf/baai/bge-m3': 1024, '@cf/baai/bge-large-en-v1.5': 1024, '@cf/baai/bge-base-en-v1.5': 768,
  'model-a': 8, 'model-c': 8, 'model-b': 16, 'too-big': 2000,
};

function hosted(): Target {
  const e = sqliteEnv();
  const models: Models = { failing: new Map(), calls: new Map() };
  const index = indexFixture();
  let broken = false;
  const vectorize = { ...index, upsert: async (vectors: Parameters<typeof index.upsert>[0]) => {
    if (broken) { broken = false; throw new Error('the process stopped mid-write'); }
    return index.upsert(vectors);
  } };
  const ai = { run: async (model: string, input: { text: string[] }) => {
    models.calls.set(model, (models.calls.get(model) ?? 0) + 1);
    if (models.failing.has(model)) throw new Error('quota exceeded');
    return { data: [vectorFor(input.text[0]!, DIMENSIONS[model]!)] };
  } };
  const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP }, AI: ai, VECTORIZE: vectorize };
  return {
    name: 'hosted', sqlite: e.sqlite, models,
    env: () => serverEnvFromBindings(bindings, e.deferred),
    fetch: (request) => worker.fetch(request, bindings, e.deferred),
    start: { provider: 'workers-ai', model: '@cf/baai/bge-m3' },
    sameSize: { provider: 'workers-ai', model: '@cf/baai/bge-large-en-v1.5' },
    otherSize: { provider: 'workers-ai', model: '@cf/baai/bge-base-en-v1.5' },
    vectorsHeld: async (modelKey) => {
      const ids = (e.sqlite.query(`SELECT id FROM embedding_receipts WHERE model_key = ?`).all(modelKey) as Array<{ id: string }>).map((r) => r.id);
      let held = 0;
      for (let i = 0; i < ids.length; i += 20) held += (await index.getByIds(ids.slice(i, i + 20))).length;
      return held;
    },
    breakNextWrite: () => { broken = true; },
  };
}

function selfHosted(): Target {
  const sqlite = seededSqlite();
  const dir = mkdtempSync(path.join(tmpdir(), 'myco-embedding-switch-'));
  temporary.push(dir);
  const models: Models = { failing: new Map(), calls: new Map() };
  const stub = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.json() as { model: string; input: string[] };
      models.calls.set(body.model, (models.calls.get(body.model) ?? 0) + 1);
      const failing = models.failing.get(body.model);
      if (failing !== undefined) return new Response('refused', { status: failing });
      return Response.json({ data: [{ embedding: vectorFor(body.input[0]!, DIMENSIONS[body.model]!) }] });
    },
  });
  stops.push(() => stub.stop(true));
  const endpoint = `http://127.0.0.1:${stub.port}`;
  let broken = false;
  const make = () => {
    const env = serverEnvFromBunConfig({ sqlite, blobDir: path.join(dir, 'blobs'), ...OWNER_ENV, SECRET_WRAP_KEY: WRAP });
    const vectors = env.vectors!;
    return { ...env, vectors: { ...vectors, upsert: async (scope: Parameters<typeof vectors.upsert>[0], v: Parameters<typeof vectors.upsert>[1]) => {
      if (broken) { broken = false; throw new Error('the process stopped mid-write'); }
      return vectors.upsert(scope, v);
    } } };
  };
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  return {
    name: 'self-hosted', sqlite, models,
    env: make,
    fetch: (request) => server.handleRequest(request, make()),
    start: { provider: 'openai-compatible', model: 'model-a', endpoint },
    sameSize: { provider: 'openai-compatible', model: 'model-c', endpoint },
    otherSize: { provider: 'openai-compatible', model: 'model-b', endpoint },
    vectorsHeld: async (modelKey) => (sqlite.query(`SELECT COUNT(*) AS n FROM local_vectors WHERE model_key = ?`).get(modelKey) as { n: number }).n,
    breakNextWrite: () => { broken = true; },
  };
}

const json = async (response: Response): Promise<Record<string, unknown>> => response.json() as Promise<Record<string, unknown>>;
const asOwnerDelete = async (route: string): Promise<Request> =>
  new Request(`https://s${route}`, { method: 'DELETE', headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' } });

/** A target with three spores embedded under its starting model. */
async function built(make: () => Target): Promise<Target & { currentKey: string; spore(id: string, content: string): void; step(now: number): Promise<Record<string, unknown>> }> {
  const t = make();
  t.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent', 'agent', 'built-in', 1, 1)`);
  const spore = (id: string, content: string) => t.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES (?, ?, 'agent', ?, 'decision', 1)`, [PROJECT, id, content]);
  spore('one', 'an architecture decision');
  spore('two', 'architecture of the store');
  spore('three', 'an unrelated observation');
  expect(await json(await t.fetch(await asOwnerPut('/api/embedding', t.start)))).toEqual({ applied: true });
  const step = async (now: number) => advanceEmbedding(t.env(), PROJECT, now) as Promise<Record<string, unknown>>;
  for (let i = 0; i < 10; i++) if ((await step(1_000)).phase === 'settled') break;
  const currentKey = (await t.env().embeddingProvider!())!.modelKey;
  expect(await t.vectorsHeld(currentKey)).toBe(3);
  return { ...t, currentKey, spore, step };
}

/** Search by meaning as the shipped search runs it. */
async function meaning(env: ServerEnv, query = 'architecture') {
  const answer = await searchProject(env.db, { projectId: PROJECT }, { query, mode: 'semantic' }, () => resolveSemanticSearch(env));
  return { unavailable: answer.provider_unavailable, ids: answer.results.map((r) => r.id).sort() };
}

const status = async (t: Target) => (await json(await t.fetch(await asOwner('/api/embedding/switch')))).switch as EmbeddingSwitchStatus | null;
const receipts = (t: Target, modelKey: string) => t.sqlite.query(`SELECT ready, COUNT(*) AS n FROM embedding_receipts WHERE model_key = ? GROUP BY ready ORDER BY ready`).all(modelKey);
const storedModel = (t: Target) => (t.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'embedding.model'`).get() as { value: string } | null)?.value;

for (const make of [hosted, selfHosted]) {
  describe(`embedding switch (${make().name})`, () => {
    for (const size of ['sameSize', 'otherSize'] as const) {
      it(`keeps search answering by meaning at every step, retires neither model meanwhile, and moves only when every source is built (${size})`, async () => {
        const t = await built(make);
        const target = t[size];
        // A plain write is refused, an unconfirmed switch is refused, and a confirmed one starts.
        expect((await t.fetch(await asOwnerPut('/api/embedding', target))).status).toBe(400);
        expect((await t.fetch(await asOwnerPost('/api/embedding/switch', target))).status).toBe(400);
        const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...target, confirm: true })));
        expect(started).toMatchObject({ applied: true, switch: { model: target.model, state: 'building', done: 0, total: 3 } });
        expect((await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }))).status).toBe(409);
        const before = storedModel(t);

        let added = false;
        let moved = false;
        for (let i = 0; i < 20 && !moved; i++) {
          // Between every two steps search answers by meaning, with the model it started with until the switch completes.
          expect(await meaning(t.env())).toEqual({ unavailable: false, ids: added ? ['four', 'one', 'two'] : ['one', 'two'] });
          const sw = await status(t);
          if (sw === null) { moved = true; break; }
          expect(storedModel(t)).toBe(before);
          expect((await t.env().embeddingProvider!())!.modelKey).toBe(t.currentKey);
          expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: added ? 4 : 3 }]);
          expect(await t.vectorsHeld(t.currentKey)).toBe(added ? 4 : 3);
          if (sw.done === 1 && !added) { t.spore('four', 'architecture added meanwhile'); added = true; }
          await t.step(2_000 + i);
        }
        expect({ moved, added }).toEqual({ moved: true, added: true });
        const newKey = (await t.env().embeddingProvider!())!.modelKey;
        expect(newKey).not.toBe(t.currentKey);
        expect(JSON.parse(storedModel(t)!)).toBe(target.model);
        expect(receipts(t, newKey)).toEqual([{ ready: 1, n: 4 }]);
        expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['four', 'one', 'two'] });
        // The old model's vectors are retired by the reconcile that already runs, once search has moved.
        for (let i = 0; i < 12; i++) await t.step(10_000 + i);
        for (let i = 0; i < 12; i++) await t.step(10_000 + VECTOR_DELETE_CONFIRM_MS + i);
        expect(receipts(t, t.currentKey)).toEqual([]);
        expect(await t.vectorsHeld(t.currentKey)).toBe(0);
        expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['four', 'one', 'two'] });
      });
    }

    it('cancels: search keeps its model and the partial vectors are retired', async () => {
      const t = await built(make);
      const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
      const id = (started.switch as EmbeddingSwitchStatus).id;
      await t.step(2_000);
      await t.step(2_001);
      const sw = (await status(t))!;
      expect(sw.done).toBe(2);
      const partialKey = (t.sqlite.query(`SELECT model_key FROM embedding_switches`).get() as { model_key: string }).model_key;
      expect(await t.vectorsHeld(partialKey)).toBe(2);
      expect(await json(await t.fetch(await asOwnerDelete(`/api/embedding/switch/${id}`)))).toEqual({ applied: true, switch: null });
      expect(await status(t)).toBeNull();
      for (let i = 0; i < 4; i++) await t.step(3_000 + i);
      for (let i = 0; i < 4; i++) await t.step(3_000 + VECTOR_DELETE_CONFIRM_MS + i);
      expect(receipts(t, partialKey)).toEqual([]);
      expect(await t.vectorsHeld(partialKey)).toBe(0);
      expect((await t.env().embeddingProvider!())!.modelKey).toBe(t.currentKey);
      expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 3 }]);
      expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
      // Another model may be chosen through a switch again.
      expect((await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.sameSize, confirm: true }))).status).toBe(200);
    });

    it('resumes after a step dies mid-write and the server restarts', async () => {
      const t = await built(make);
      await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
      await t.step(2_000);
      t.breakNextWrite();
      await expect(t.step(2_001)).rejects.toThrow('the process stopped mid-write');
      expect((await status(t))!.state).toBe('building');
      // A fresh env over the same store is a restarted server: the switch continues from what is stored.
      let moved = false;
      for (let i = 0; i < 10 && !moved; i++) {
        expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
        await t.step(3_000 + i);
        moved = (await status(t)) === null;
      }
      expect(moved).toBe(true);
      expect(JSON.parse(storedModel(t)!)).toBe(t.otherSize.model);
    });

    it('pauses with the reason when the new model fails, keeps the current model in use, and resumes', async () => {
      const t = await built(make);
      const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
      const id = (started.switch as EmbeddingSwitchStatus).id;
      t.models.failing.set(t.otherSize.model, 429);
      await t.step(2_000);
      const paused = (await status(t))!;
      expect(paused.state).toBe('paused');
      expect(paused.reason).toMatch(t.name === 'hosted' ? /could not be reached/ : /HTTP 429.*quota or rate limit/);
      expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 3 }]);
      expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
      // While paused, the new model is not asked again.
      const asked = t.models.calls.get(t.otherSize.model) ?? 0;
      for (let i = 0; i < 3; i++) await t.step(2_100 + i);
      expect(t.models.calls.get(t.otherSize.model) ?? 0).toBe(asked);
      t.models.failing.delete(t.otherSize.model);
      expect(await json(await t.fetch(await asOwnerPost(`/api/embedding/switch/${id}/resume`)))).toMatchObject({ applied: true, switch: { state: 'building', reason: null } });
      for (let i = 0; i < 10 && (await status(t)) !== null; i++) await t.step(3_000 + i);
      expect(await status(t)).toBeNull();
      expect(JSON.parse(storedModel(t)!)).toBe(t.otherSize.model);
    });
  });
}

describe('a model larger than search stores', () => {
  it('is refused before a hosted switch starts', async () => {
    const t = await built(hosted);
    const answer = await t.fetch(await asOwnerPost('/api/embedding/switch', { provider: 'workers-ai', model: '@cf/pfnet/plamo-embedding-1b', confirm: true }));
    expect(answer.status).toBe(400);
    expect(String((await json(answer)).detail)).toMatch(/too large for search: it has 2048 dimensions and search stores at most 1536/);
    expect(await status(t)).toBeNull();
  });

  it('pauses a self-hosted switch whose model answers more dimensions than search stores, and search keeps its model', async () => {
    const t = await built(selfHosted);
    await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.start, model: 'too-big', confirm: true }));
    await t.step(2_000);
    expect(await status(t)).toMatchObject({ state: 'paused', reason: expect.stringMatching(/larger than search stores \(at most 1536 dimensions\)/) });
    expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
  });
});

describe('embedding work while a switch stands', () => {
  it('dispatches the new model\'s writes, waits while paused, and keeps a retained model\'s vectors out of the backlog', async () => {
    const t = await built(selfHosted);
    const pending = async () => {
      const plan = (await embeddingWorkPlan(t.env()))!;
      return hasEmbeddingWork(t.env().db, PROJECT, plan.model, 2_000, plan);
    };
    expect(await pending()).toBe(false);
    const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
    expect(await pending()).toBe(true);
    t.sqlite.run(`UPDATE embedding_switches SET state = 'paused', reason = 'held for the test'`);
    expect(await pending()).toBe(false);
    expect((started.switch as EmbeddingSwitchStatus).total).toBe(3);
  });
});

describe('reconcile while a switch stands', () => {
  it('retires no vector of a retained model, whichever model writes', async () => {
    const t = await built(selfHosted);
    const env = t.env();
    const other = { modelKey: 'other-model', embed: async (text: string) => vectorFor(text, 8) };
    // The new model writing alone, as it does while no current model can be reached, keeps the current model's vectors.
    for (let i = 0; i < 6; i++) await reconcileEmbedding({ db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: other, retain: [t.currentKey] }, PROJECT, 2_000 + i);
    expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 3 }]);
    expect(receipts(t, 'other-model')).toEqual([{ ready: 1, n: 3 }]);
    // The current model writing with the new one building keeps both.
    const current = (await env.embeddingProvider!())!;
    for (let i = 0; i < 6; i++) await reconcileEmbedding({ db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: current, building: other }, PROJECT, 3_000 + i);
    expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 3 }]);
    expect(receipts(t, 'other-model')).toEqual([{ ready: 1, n: 3 }]);
  });
});
