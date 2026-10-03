/**
 * Switch embedding model, on both targets through their shipped env and request handler: search keeps answering by
 * meaning at every step while the new model's vectors are built, reconcile retires neither model's vectors meanwhile,
 * search moves only once every source (one added meanwhile included) holds a vector under the new model, a cancel
 * leaves search on its model and retires the partial vectors, a restart resumes, a failure the provider may recover from
 * is tried again after a wait while one that needs an admin pauses the switch with its reason, an archived Project or
 * a source the model cannot read never holds the switch back, the new model is calibrated before search moves to it,
 * and a model larger than search stores stays refused.
 */
import { afterAll, describe, expect, it, setSystemTime } from 'bun:test';
import { mkdtempSync, rmSync } from "../support/fenced-fs.mjs";
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
import { SWITCH_STALL_MS, completeEmbeddingSwitch, embeddingSwitchStatus, embeddingWorkPlan, passedOverForHealth, switchFailureAction } from '@myco-server-worker/core/embedding/switch.js';
import { RECOVERED_SWITCH, holdRecoveredSwitch } from '@myco-server-worker/core/embedding/switch-store.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { EmbeddingUnavailable, VECTOR_DELETE_CONFIRM_MS, workersAiFailure } from '@myco-server-worker/core/embedding/provider.js';
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

/**
 * What each target's models answer, and which of them fail: a self-hosted model answers the HTTP status and headers
 * set for it, and a hosted model throws the words set for it, as the Workers AI binding does.
 */
interface Failing { status: number; headers?: Record<string, string>; words: string }
interface Models { failing: Map<string, Failing>; refusing: Map<string, Failing>; calls: Map<string, number> }

/** The word a source's text carries for a model in `refusing` to refuse that one text. */
const REFUSED_TEXT = 'unembeddable';

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
  const models: Models = { failing: new Map(), refusing: new Map(), calls: new Map() };
  const index = indexFixture();
  let broken = false;
  const vectorize = { ...index, upsert: async (vectors: Parameters<typeof index.upsert>[0]) => {
    if (broken) { broken = false; throw new Error('the process stopped mid-write'); }
    return index.upsert(vectors);
  } };
  const ai = { run: async (model: string, input: { text: string[] }) => {
    models.calls.set(model, (models.calls.get(model) ?? 0) + 1);
    const failing = models.failing.get(model) ?? (input.text[0]!.includes(REFUSED_TEXT) ? models.refusing.get(model) : undefined);
    if (failing !== undefined) throw new Error(failing.words);
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
  const models: Models = { failing: new Map(), refusing: new Map(), calls: new Map() };
  const stub = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.json() as { model: string; input: string[] };
      models.calls.set(body.model, (models.calls.get(body.model) ?? 0) + 1);
      const failing = models.failing.get(body.model) ?? (body.input[0]!.includes(REFUSED_TEXT) ? models.refusing.get(body.model) : undefined);
      if (failing !== undefined) return new Response(failing.words === '' ? 'refused' : failing.words, { status: failing.status, headers: failing.headers ?? {} });
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
        for (let i = 0; i < 40 && !moved; i++) {
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
        // Every spore is calibrated under the new model by the time search moves to it.
        expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_receipts WHERE model_key = ? AND type = 'spore' AND neighbor_mean IS NULL`).get(newKey)).toEqual({ n: 0 });
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
      for (let i = 0; i < 20 && !moved; i++) {
        expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
        await t.step(3_000 + i);
        moved = (await status(t)) === null;
      }
      expect(moved).toBe(true);
      expect(JSON.parse(storedModel(t)!)).toBe(t.otherSize.model);
    });

    it('waits and tries again after a provider error, keeping the current model in use, and clears the wait once the model writes', async () => {
      const t = await built(make);
      await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
      t.models.failing.set(t.otherSize.model, { status: 503, words: 'AiError: 3001: Internal server error' });
      await t.step(2_000);
      const waiting = (await status(t))!;
      expect({ state: waiting.state, retryAt: waiting.retryAt }).toEqual({ state: 'building', retryAt: 2_000 + 60_000 });
      expect(waiting.reason).toMatch(t.name === 'hosted' ? /could not answer \(“AiError: 3001: Internal server error”\)/ : /had a problem \(HTTP 503\)/);
      expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 3 }]);
      expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
      // Until the wait is over the new model is not asked; then it is, and a second failure waits twice as long.
      const asked = t.models.calls.get(t.otherSize.model) ?? 0;
      for (let i = 0; i < 3; i++) await t.step(2_100 + i);
      expect(t.models.calls.get(t.otherSize.model) ?? 0).toBe(asked);
      await t.step(62_000);
      expect(t.models.calls.get(t.otherSize.model)).toBe(asked + 1);
      expect((await status(t))!.retryAt).toBe(62_000 + 120_000);
      t.models.failing.delete(t.otherSize.model);
      await t.step(182_000);
      expect(await status(t)).toMatchObject({ state: 'building', retryAt: null, reason: null });
      for (let i = 0; i < 20 && (await status(t)) !== null; i++) await t.step(183_000 + i);
      expect(await status(t)).toBeNull();
      expect(JSON.parse(storedModel(t)!)).toBe(t.otherSize.model);
    });

    it('waits for a spent quota to renew, as the provider says', async () => {
      const t = await built(make);
      await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
      const now = Date.UTC(2026, 9, 2, 15, 30);
      t.models.failing.set(t.otherSize.model, t.name === 'hosted'
        ? { status: 0, words: 'AiError: 4006: you have used up your daily free allocation of 10,000 neurons, please upgrade' }
        : { status: 429, headers: { 'retry-after': '600' }, words: '' });
      // The provider reads the wall clock for when a daily allowance renews; it is held at the step's instant.
      setSystemTime(new Date(now));
      try { await t.step(now); } finally { setSystemTime(); }
      const waiting = (await status(t))!;
      expect(waiting.state).toBe('building');
      expect(waiting.retryAt).toBe(t.name === 'hosted' ? Date.UTC(2026, 9, 3) : now + 600_000);
      expect(waiting.reason).toMatch(t.name === 'hosted' ? /daily allowance is used up.*renews/ : /asked Myco to slow down \(HTTP 429\)/);
    });
  });
}

describe('what a failure of the new model does', () => {
  it('passes one source over for a refusal of its text, waits out what may pass, and pauses for what needs an admin', () => {
    const http = (status: number) => new EmbeddingUnavailable('x', { kind: 'http', status, retryAfterMs: null, detail: null });
    const actions = Object.fromEntries([400, 401, 403, 404, 408, 413, 422, 429, 503].map((status) => [status, switchFailureAction(http(status), 0, 0).action]));
    expect(actions).toEqual({ 400: 'skip', 401: 'pause', 403: 'pause', 404: 'pause', 408: 'wait', 413: 'skip', 422: 'skip', 429: 'wait', 503: 'wait' });
    expect(switchFailureAction(new EmbeddingUnavailable('x', workersAiFailure(new Error('AiError: 3010: Invalid or incomplete input for the model'), false, 0)), 0, 0).action).toBe('skip');
    expect(switchFailureAction(new EmbeddingUnavailable('x', workersAiFailure(new Error('AiError: 3001: Internal server error'), false, 0)), 0, 0)).toMatchObject({ action: 'wait', reason: expect.stringContaining('AiError: 3001: Internal server error') });
  });
});

describe('a provider that turns the key down', () => {
  it('pauses the switch with the reason, asks nothing more, and resumes on request', async () => {
    const t = await built(selfHosted);
    const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
    const id = (started.switch as EmbeddingSwitchStatus).id;
    t.models.failing.set(t.otherSize.model, { status: 401, words: '' });
    await t.step(2_000);
    expect(await status(t)).toMatchObject({ state: 'paused', retryAt: null, reason: expect.stringMatching(/turned down its key \(HTTP 401\)/) });
    const asked = t.models.calls.get(t.otherSize.model) ?? 0;
    for (let i = 0; i < 3; i++) await t.step(10_000_000 + i);
    expect(t.models.calls.get(t.otherSize.model) ?? 0).toBe(asked);
    expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
    t.models.failing.delete(t.otherSize.model);
    expect(await json(await t.fetch(await asOwnerPost(`/api/embedding/switch/${id}/resume`)))).toMatchObject({ applied: true, switch: { state: 'building', reason: null } });
    for (let i = 0; i < 20 && (await status(t)) !== null; i++) await t.step(3_000 + i);
    expect(await status(t)).toBeNull();
  });
});

describe('what never holds a switch back', () => {
  it('builds and counts only Projects that are not archived, and retires an archived Project\'s old vectors once search moves', async () => {
    const t = await built(selfHosted);
    t.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES ('proj_2', 'old-1', 'agent', 'archived architecture', 'decision', 1), ('proj_2', 'old-2', 'agent', 'archived notes', 'decision', 1)`);
    for (let i = 0; i < 10; i++) await advanceEmbedding(t.env(), 'proj_2', 1_500 + i);
    expect(receipts(t, t.currentKey)).toEqual([{ ready: 1, n: 5 }]);
    t.sqlite.run(`UPDATE projects SET archived_at = 1, archived_by = 'mem_machine_1' WHERE project_id = 'proj_2'`);
    const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
    expect(started).toMatchObject({ switch: { total: 3 } });
    // An archived Project is stepped only to retire, so it writes nothing under the new model while the switch stands.
    expect(await advanceEmbedding(t.env(), 'proj_2', 1_900)).toMatchObject({ phase: 'settled', processed: 0 });
    for (let i = 0; i < 30 && (await status(t)) !== null; i++) await t.step(2_000 + i);
    expect(await status(t)).toBeNull();
    const newKey = (await t.env().embeddingProvider!())!.modelKey;
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_receipts WHERE project_id = 'proj_2' AND model_key = ?`).get(newKey)).toEqual({ n: 0 });
    const plan = (await embeddingWorkPlan(t.env(), 5_000))!;
    expect(await hasEmbeddingWork(t.env().db, 'proj_2', plan.model, 5_000, { ...plan, retireOnly: true })).toBe(true);
    for (let i = 0; i < 4; i++) await advanceEmbedding(t.env(), 'proj_2', 5_000 + i);
    for (let i = 0; i < 4; i++) await advanceEmbedding(t.env(), 'proj_2', 5_000 + VECTOR_DELETE_CONFIRM_MS + i);
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_receipts WHERE project_id = 'proj_2'`).get()).toEqual({ n: 0 });
    expect(await hasEmbeddingWork(t.env().db, 'proj_2', plan.model, 5_000 + VECTOR_DELETE_CONFIRM_MS + 10, { ...plan, retireOnly: true })).toBe(false);
  });

  it('passes over a source no model can read, names it, completes, and keeps the Project\'s embedding moving after the flip', async () => {
    const t = await built(selfHosted);
    await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
    t.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'unreadable', 's', 'e', 'm', 'A plan whose body is gone', NULL, 'gone-key', 'h', 'active', 1, 1, 't', 1)`);
    let named = false;
    let whole = false;
    for (let i = 0; i < 30 && (await status(t)) !== null; i++) {
      const sw = (await status(t))!;
      expect({ total: sw.total, listed: sw.passedOver.sources.length }).toEqual({ total: 4, listed: sw.passedOver.count });
      whole ||= sw.done === sw.total;
      if (sw.passedOver.count === 1) {
        named = true;
        expect(sw.passedOver.sources).toEqual([{ projectId: PROJECT, projectName: 'a', type: 'plan', title: 'A plan whose body is gone', reason: 'its stored text is missing', anyModel: true }]);
      }
      await t.step(2_000 + i);
    }
    expect({ named, whole, moved: await status(t) === null, model: JSON.parse(storedModel(t)!) }).toEqual({ named: true, whole: true, moved: true, model: t.otherSize.model });
    // After the flip the Project's runs neither fail on the source nor stop: the replaced model's vectors are retired.
    for (let i = 0; i < 12; i++) await t.step(10_000 + i);
    for (let i = 0; i < 12; i++) await t.step(10_000 + VECTOR_DELETE_CONFIRM_MS + i);
    expect(receipts(t, t.currentKey)).toEqual([]);
    expect(await json(await t.fetch(await asOwner('/api/embedding/passed-over')))).toEqual({
      count: 1, sources: [{ projectId: PROJECT, projectName: 'a', type: 'plan', title: 'A plan whose body is gone', reason: 'its stored text is missing', anyModel: true }],
    });
  });

  it('passes over a source a provider refuses as input, under that model only, and completes', async () => {
    for (const make of [hosted, selfHosted]) {
      const t = await built(make);
      t.models.refusing.set(t.otherSize.model, make === hosted ? { status: 0, words: 'AiError: 3010: Invalid or incomplete input for the model: input is too long' } : { status: 400, words: 'input is too long for this model' });
      t.spore('long', `architecture ${REFUSED_TEXT} beyond the model's limit`);
      for (let i = 0; i < 4; i++) await t.step(1_800 + i);
      await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
      for (let i = 0; i < 30 && (await status(t)) !== null; i++) await t.step(2_000 + i);
      expect({ target: t.name, moved: await status(t) === null }).toEqual({ target: t.name, moved: true });
      const listed = await passedOverForHealth(t.env(), 2_100);
      expect(listed).toMatchObject({ count: 1, sources: [{ title: 'decision', anyModel: false, reason: expect.stringMatching(make === hosted ? /the model refused its text \(“AiError: 3010/ : /the model refused its text with HTTP 400 \(“input is too long for this model”\)/) }] });
      // Once the replaced model's vectors are retired, nothing is left: the refused source is not asked again within a day.
      for (let i = 0; i < 12; i++) await t.step(2_200 + i);
      for (let i = 0; i < 12; i++) await t.step(2_200 + VECTOR_DELETE_CONFIRM_MS + i);
      const plan = (await embeddingWorkPlan(t.env(), 2_300 + VECTOR_DELETE_CONFIRM_MS))!;
      expect(await hasEmbeddingWork(t.env().db, PROJECT, plan.model, 2_300 + VECTOR_DELETE_CONFIRM_MS, plan)).toBe(false);
    }
  });

  it('without a switch, an unreadable source neither fails a run nor holds back calibration or retirement, and a new revision clears it', async () => {
    const t = await built(selfHosted);
    t.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'unreadable', 's', 'e', 'm', 'A plan whose body is gone', NULL, 'gone-key', 'h', 'active', 1, 1, 't', 1)`);
    t.sqlite.run(`DELETE FROM spores WHERE id = 'three'`);
    expect(await t.step(3_000)).toMatchObject({ phase: 'passed-over', processed: 1 });
    for (let i = 0; i < 6; i++) await t.step(3_001 + i);
    for (let i = 0; i < 6; i++) await t.step(3_001 + VECTOR_DELETE_CONFIRM_MS + i);
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_receipts WHERE record_id = 'three'`).get()).toEqual({ n: 0 });
    const plan = (await embeddingWorkPlan(t.env(), 3_100 + VECTOR_DELETE_CONFIRM_MS))!;
    expect(await hasEmbeddingWork(t.env().db, PROJECT, plan.model, 3_100 + VECTOR_DELETE_CONFIRM_MS, plan)).toBe(false);
    // Its text stored again is a new revision: it is read, written, and no longer passed over.
    t.sqlite.run(`UPDATE plans SET content = 'architecture restored', blob_key = NULL WHERE plan_key = 'unreadable'`);
    for (let i = 0; i < 4; i++) await t.step(4_000 + VECTOR_DELETE_CONFIRM_MS + i);
    expect(await json(await t.fetch(await asOwner('/api/embedding/passed-over')))).toEqual({ count: 0, sources: [] });
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_source_failures`).get()).toEqual({ n: 0 });
  });

  it('retries a body whose read fails, rather than passing it over', async () => {
    const t = await built(selfHosted);
    t.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', 'flaky-key', 10, 'text/plain', 't', 1, '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')`);
    t.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'flaky', 's', 'e', 'm', 'A plan on a flaky disk', NULL, 'flaky-key', 'h', 'active', 1, 1, 't', 1)`);
    const env = t.env();
    // The read fails with a TypeError, and releasing the reader succeeds, as a dropped connection leaves it.
    const reader = { read: async () => { throw new TypeError('the read was cut off'); }, cancel: async () => undefined, releaseLock: () => undefined };
    const failingRead = { ...env.blobs, get: async () => ({ body: { getReader: () => reader } }) } as unknown as typeof env.blobs;
    await expect(reconcileEmbedding({ db: env.db, blobs: failingRead, vectors: env.vectors!, provider: (await env.embeddingProvider!())! }, PROJECT, 3_000)).rejects.toThrow('the read was cut off');
    expect(t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_source_failures`).get()).toEqual({ n: 0 });
  });

  it('says why a building switch has not moved for a while', async () => {
    const t = await built(selfHosted);
    const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
    const at = (started.switch as EmbeddingSwitchStatus).startedAt;
    expect((await embeddingSwitchStatus(t.env(), at + SWITCH_STALL_MS - 1))!.stalled).toBeNull();
    expect((await embeddingSwitchStatus(t.env(), at + SWITCH_STALL_MS + 60_000))!.stalled).toBe('No embedding run has started in the last 31 minutes, so rebuilding search has not moved.');
    // A model held off after failures says so too, wait or no wait.
    t.models.failing.set(t.otherSize.model, { status: 503, words: '' });
    await t.step(at + 1_000);
    expect((await embeddingSwitchStatus(t.env(), at + SWITCH_STALL_MS + 60_000))!.stalled).toBe('Rebuilding search has not moved for 31 minutes: the new model has failed 1 time in a row.');
  });

  it('caps how long a provider\'s Retry-After holds a switch off, and Resume asks a held-off model at once', async () => {
    const t = await built(selfHosted);
    const started = await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })));
    const id = (started.switch as EmbeddingSwitchStatus).id;
    t.models.failing.set(t.otherSize.model, { status: 429, headers: { 'retry-after': String(30 * 24 * 3600) }, words: '' });
    await t.step(2_000);
    expect((await status(t))!.retryAt).toBe(2_000 + 6 * 60 * 60_000);
    t.models.failing.delete(t.otherSize.model);
    expect(await json(await t.fetch(await asOwnerPost(`/api/embedding/switch/${id}/resume`)))).toMatchObject({ applied: true, switch: { state: 'building', retryAt: null } });
    const asked = t.models.calls.get(t.otherSize.model) ?? 0;
    await t.step(2_100);
    expect(t.models.calls.get(t.otherSize.model)).toBe(asked + 1);
  });

  it('grows its estimate as sources are added, from the tokens each read when it started', async () => {
    const t = await built(selfHosted);
    const started = (await json(await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true })))).switch as EmbeddingSwitchStatus;
    t.spore('four', 'architecture added meanwhile');
    t.spore('five', 'more architecture added meanwhile');
    expect((await status(t))!.estimatedTokens).toBe(Math.ceil(started.estimatedTokens * 5 / 3));
  });
});

describe('guards the completion and the settings writer carry', () => {
  /** The store, with `before` run once just ahead of its next batch: a write that lands between a check and the batch. */
  const racing = (db: RelationalStore, before: () => void): RelationalStore => {
    let armed = true;
    return { ...db, prepare: db.prepare.bind(db), batch: async (statements) => { if (armed) { armed = false; before(); } return db.batch(statements); } } as RelationalStore;
  };

  it('moves search and ends the switch together when a passed-over source is what completes it, and keeps the source recorded', async () => {
    const t = await built(selfHosted);
    await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
    for (let i = 0; i < 20 && (await status(t))!.done < 3; i++) await t.step(2_000 + i);
    t.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'unreadable', 's', 'e', 'm', 'A plan whose body is gone', NULL, 'gone-key', 'h', 'active', 1, 1, 't', 1)`);
    for (let i = 0; i < 20 && (await status(t)) !== null; i++) await t.step(3_000 + i);
    expect({ standing: await status(t), model: JSON.parse(storedModel(t)!), recorded: t.sqlite.query(`SELECT COUNT(*) AS n FROM embedding_source_failures`).get() })
      .toEqual({ standing: null, model: t.otherSize.model, recorded: { n: 1 } });
  });

  it('does not move search when a source arrives between the completion check and its batch', async () => {
    const t = await built(selfHosted);
    await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
    const env = t.env();
    // Build every source and calibrate, without letting a step complete the switch.
    for (let i = 0; i < 20; i++) await reconcileEmbedding({ db: env.db, blobs: env.blobs, vectors: env.vectors!, provider: (await env.embeddingProvider!())!,
      building: (await env.embeddingProviderFor!({ 'embedding.provider': t.otherSize.provider, 'embedding.model': t.otherSize.model, 'embedding.base_url': t.otherSize.endpoint })).provider!,
      retain: [t.currentKey], calibrate: (await embeddingWorkPlan(env, 3_000))!.switching! }, PROJECT, 3_000 + i);
    const raced = { ...env, db: racing(env.db, () => t.spore('late', 'architecture arriving late')) };
    expect(await completeEmbeddingSwitch(raced, 4_000)).toBe(false);
    expect(await status(t)).toMatchObject({ state: 'building' });
    expect(JSON.parse(storedModel(t)!)).toBe(t.start.model);
  });

  it('refuses a settings write when a switch starts between its check and its batch', async () => {
    const t = hosted();
    const db = racing(sqliteRelationalStore(t.sqlite), () => t.sqlite.run(`INSERT INTO embedding_switches (slot, id, provider, model, endpoint, model_key, from_model_key, estimated_tokens, estimated_sources, progressed_at, state, reason, started_at, started_by, updated_at)
      VALUES ('deployment', 'raced', 'workers-ai', '@cf/baai/bge-base-en-v1.5', NULL, 'k2', 'k1', 0, 0, 1, 'building', NULL, 1, 'mem_machine_1', 1)`));
    const written = await settingsWriter(db, { target: 'cloudflare' }).setEmbedding({ provider: 'workers-ai', model: '@cf/baai/bge-large-en-v1.5' }, 'mem_machine_1', 5_000);
    expect(written).toEqual({ applied: false, refusal: { reason: 'conflict', leaf: 'embedding.provider' } });
    expect(storedModel(t)).toBeUndefined();
  });
});

describe('a recovered copy', () => {
  it('holds the switch it carries, saying why, so it spends nothing until an admin resumes it', async () => {
    const t = await built(selfHosted);
    await t.fetch(await asOwnerPost('/api/embedding/switch', { ...t.otherSize, confirm: true }));
    await holdRecoveredSwitch(t.env().db, 9_000);
    expect(await status(t)).toMatchObject({ state: 'paused', reason: RECOVERED_SWITCH });
    const asked = t.models.calls.get(t.otherSize.model) ?? 0;
    await t.step(9_100);
    expect(t.models.calls.get(t.otherSize.model) ?? 0).toBe(asked);
  });

  it('holds nothing in a store that predates the switch', async () => {
    const sqlite = seededSqlite();
    sqlite.run('DROP TABLE embedding_switches');
    await holdRecoveredSwitch(sqliteRelationalStore(sqlite), 1);
  });
});

describe('the estimate shown before a switch starts', () => {
  it('names the sources to read, the tokens, and the cost where the provider publishes a price', async () => {
    const t = await built(hosted);
    const answer = await json(await t.fetch(await asOwnerPost('/api/embedding/switch/estimate', t.otherSize)));
    const estimate = answer.estimate as { sources: number; estimatedTokens: number; estimatedUsd: number };
    expect({ applied: answer.applied, sources: estimate.sources }).toEqual({ applied: true, sources: 3 });
    expect(estimate.estimatedTokens).toBeGreaterThan(0);
    expect(estimate.estimatedUsd).toBeCloseTo(estimate.estimatedTokens / 1_000_000 * 0.067, 12);
    expect(answer.estimate).toMatchObject({ passedOver: { count: 0, sources: [] } });
    expect(await status(t)).toBeNull();
    const local = await built(selfHosted);
    expect(await json(await local.fetch(await asOwnerPost('/api/embedding/switch/estimate', local.otherSize)))).toMatchObject({ estimate: { sources: 3, estimatedUsd: null } });
  });
});

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
    expect(await status(t)).toMatchObject({ state: 'paused', reason: expect.stringMatching(/too large for search, which holds up to 1536 numbers for each/) });
    expect(await meaning(t.env())).toEqual({ unavailable: false, ids: ['one', 'two'] });
  });
});

describe('embedding work while a switch stands', () => {
  it('dispatches the new model\'s writes, waits while paused, and keeps a retained model\'s vectors out of the backlog', async () => {
    const t = await built(selfHosted);
    const pending = async () => {
      const plan = (await embeddingWorkPlan(t.env(), 2_000))!;
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
