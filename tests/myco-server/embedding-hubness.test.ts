import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { reconcileEmbedding, type EmbeddingContext, type EmbeddingStep } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { CURRENT_SPORE_VECTORS, missingSporeVectors } from '../../packages/myco-server/src/core/embedding/hubness.js';
import { VECTOR_DELETE_CONFIRM_MS as C, VECTOR_LOST_MS as LOST, VECTOR_REWRITE_LIMIT, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
import { embeddingRunReport, runEmbeddingSteps } from '../../packages/myco-server/src/core/embedding/run.js';
import { cosineSimilarity, type VectorStore } from '../../packages/myco-server/src/core/embedding/vectors.js';
import { hasEmbeddingWork } from '../../packages/myco-server/src/core/embedding/jobs.js';
import type { RelationalStore } from '../../packages/myco-server/src/core/adapters.js';

configureSqliteLibrary();
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

const T = 1_000_000_000;
const MODEL = 'test-model';
const SCOPE = { projectId: 'p', modelKey: MODEL };
type Target = 'sqlite-vec' | 'vectorize' | 'vectorize-deferred';
const TARGETS: Target[] = ['sqlite-vec', 'vectorize', 'vectorize-deferred'];
/** The cost bound: one calibration step per this many settled members. */
const PAGE = 50;

/** A seeded generator, so a failing sequence replays. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An eight-dimensional embedding drawn from the text, so every spore sits at its own distances. */
function embedding(text: string): number[] {
  let seed = 2166136261;
  for (let i = 0; i < text.length; i++) seed = Math.imul(seed ^ text.charCodeAt(i), 16777619);
  const next = random(seed);
  return Array.from({ length: 8 }, () => next() * 2 - 1);
}

/** A pause point: the armed call waits until the test releases it. */
function pausePoint() {
  let armed = 0;
  let release: (() => void) | null = null;
  let reached = Promise.withResolvers<void>();
  return {
    /** The `nth` call from now pauses. */
    arm: (nth = 1) => { armed = nth; reached = Promise.withResolvers<void>(); },
    get reached() { return reached.promise; },
    release: () => release!(),
    pass: async () => {
      if (armed === 0 || --armed > 0) return;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      reached.resolve();
      await wait;
    },
  };
}

function fixture(target: Target) {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  insert('projects', { project_id: 'p', name: 'project', created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  const spore = (id: string, content: string) => insert('spores', { project_id: 'p', id, agent_id: 'a', content, observation_type: 'decision', created_at: 1 });
  const index = target === 'vectorize-deferred' ? indexFixture({ deferred: true }) : null;
  const native: VectorStore = target === 'sqlite-vec' ? sqliteVectorStore(f.sqlite) : cloudflareVectorStore(index ?? indexFixture());
  const reads: string[][] = [];
  const vectors: VectorStore = { ...native, get: async (scope, ids) => { reads.push(ids); return native.get(scope, ids); } };
  // A settled member dropped other than by leaving is a full recompute: a repair the incremental path never needs.
  f.sqlite.run('CREATE TEMP TABLE dropped_settled (id TEXT)');
  f.sqlite.run(`CREATE TEMP TRIGGER record_dropped_settled AFTER DELETE ON embedding_hubness_members WHEN old.state <> 2
    BEGIN INSERT INTO dropped_settled VALUES (old.id); END`);
  const repaired = () => (f.sqlite.query('SELECT COUNT(*) AS n FROM dropped_settled').get() as { n: number }).n;
  const commitPause = pausePoint();
  const db: RelationalStore = { prepare: (sql) => f.db.prepare(sql), batch: async (statements) => { await commitPause.pass(); return f.db.batch(statements); } };
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async (text) => embedding(text) };
  const context: EmbeddingContext = { db, blobs: f.bucket, vectors, provider };
  const step = (now: number) => reconcileEmbedding(context, 'p', now);
  /** Steps until a step processes nothing, applying queued vector mutations after each; returns the phases stepped. */
  const settle = async (now: number): Promise<EmbeddingStep['phase'][]> => {
    const phases: EmbeddingStep['phase'][] = [];
    for (let i = 0; i < 400; i++) {
      const { phase, processed } = await step(now);
      index?.apply();
      phases.push(phase);
      if (processed === 0) return phases;
    }
    throw new Error(`embedding did not settle: ${phases.slice(-5).join(',')}`);
  };
  const work = (now: number) => hasEmbeddingWork(f.db, 'p', MODEL, now);
  const current = () => (f.sqlite.query(`${CURRENT_SPORE_VECTORS} ORDER BY r.id`).all('p', MODEL) as Array<{ id: string }>).map((r) => r.id);
  const members = () => f.sqlite.query('SELECT id, state, n FROM embedding_hubness_members ORDER BY id').all() as Array<{ id: string; state: number; n: number }>;
  /** Each current spore vector's distance moments recomputed from the vector store, in one pass over all pairs. */
  const recompute = async () => {
    const ids = current();
    const held = new Map((await native.get(SCOPE, ids)).map((v) => [v.id, v.values]));
    expect(held.size).toBe(ids.length);
    return new Map(ids.map((id) => {
      let n = 0, mean = 0, m2 = 0;
      for (const other of ids) {
        if (other === id) continue;
        const d = 1 - cosineSimilarity(held.get(id)!, held.get(other)!);
        n++;
        const delta = d - mean;
        mean += delta / n;
        m2 += delta * (d - mean);
      }
      return [id, { mean: n === 0 ? null : mean, std: n === 0 ? null : Math.sqrt(m2 / n) }];
    }));
  };
  /** Every current spore vector's published statistics equal a full recompute, and its moments count every other one. */
  const expectExact = async () => {
    const expected = await recompute();
    const published = f.sqlite.query(`SELECT id, neighbor_mean, neighbor_std FROM embedding_receipts WHERE id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...expected.keys()])) as Array<{ id: string; neighbor_mean: number | null; neighbor_std: number | null }>;
    expect(published).toHaveLength(expected.size);
    for (const row of published) {
      const want = expected.get(row.id)!;
      expect(Math.abs(row.neighbor_mean! - want.mean!)).toBeLessThan(1e-12);
      expect(Math.abs(row.neighbor_std! - want.std!)).toBeLessThan(1e-12);
    }
    expect(members()).toEqual(current().map((id) => ({ id, state: 0, n: expected.size - 1 })));
    expect(f.sqlite.query('SELECT hubness_model, hubness_count FROM embedding_cursors').get()).toEqual({ hubness_model: MODEL, hubness_count: expected.size });
  };
  return { ...f, spore, index, native, reads, commitPause, context, step, settle, work, current, members, recompute, expectExact, repaired };
}

const hubnessSteps = (phases: EmbeddingStep['phase'][]) => phases.filter((p) => p === 'hubness').length;
const MINUTE = 60_000;

/** The vector store drops the first `lose` writes of one spore's vector, and returns only the vectors it holds; counts that spore's writes. */
function losing(f: ReturnType<typeof fixture>, record: string, lose = Infinity) {
  const inner = f.context.vectors;
  let writes = 0;
  f.context.vectors = { ...inner, upsert: async (scope, vectors) => {
    const kept = vectors.filter((v) => v.metadata.record_id !== record || ++writes > lose);
    if (kept.length > 0) await inner.upsert(scope, kept);
  } };
  return { get writes() { return writes; } };
}

const receiptOf = (f: ReturnType<typeof fixture>, record: string) =>
  f.sqlite.query('SELECT id, ready, rewrites, neighbor_mean FROM embedding_receipts WHERE record_id = ?').get(record) as { id: string; ready: number; rewrites: number; neighbor_mean: number | null } | null;
/** One operation's steps over a membership of `n`: one page of settled members per step. */
const operationSteps = (n: number) => Math.max(1, Math.ceil(n / PAGE));

describe.each(TARGETS)('%s: spore calibration', (target) => {
  test('after any sequence of adds, removals and revisions, every spore\'s moments equal a full recompute, at a cost proportional to the change', async () => {
    for (const seed of [1, 2, 3]) {
      const f = fixture(target);
      const next = random(seed);
      let serial = 0;
      const text = () => `spore text ${seed}-${serial}-${next()}`;
      const live: string[] = [];
      for (let i = 0; i < 60; i++) { const id = `s${String(serial++).padStart(4, '0')}`; f.spore(id, text()); live.push(id); }
      let now = T;
      await f.settle(now);
      await f.expectExact();
      expect(f.repaired()).toBe(0);
      expect(await f.work(now)).toBe(false);
      for (let round = 0; round < 8; round++) {
        now += C;
        const before = f.current().length;
        const changes = 1 + Math.floor(next() * 4);
        for (let c = 0; c < changes; c++) {
          const roll = next();
          const pick = () => live.splice(Math.floor(next() * live.length), 1)[0]!;
          if (roll < 0.35 || live.length < 3) { const id = `s${String(serial++).padStart(4, '0')}`; f.spore(id, text()); live.push(id); }
          else if (roll < 0.55) f.sqlite.run("DELETE FROM spores WHERE project_id = 'p' AND id = ?", [pick()]);
          else if (roll < 0.7) f.sqlite.run("UPDATE spores SET status = 'superseded' WHERE project_id = 'p' AND id = ?", [pick()]);
          else { const id = live[Math.floor(next() * live.length)]!; f.sqlite.run("UPDATE spores SET content = ? WHERE project_id = 'p' AND id = ?", [text(), id]); }
        }
        const phases = await f.settle(now);
        const size = Math.max(before, f.current().length);
        // At most one leaving and one joining operation for a change of fewer than a page of spores.
        expect({ seed, round, steps: hubnessSteps(phases) <= 2 * operationSteps(size) }).toEqual({ seed, round, steps: true });
        await f.expectExact();
        expect(f.repaired()).toBe(0);
        expect(await f.work(now)).toBe(false);
      }
    }
  });

  test('one spore added to a settled set of 316 costs one step per page of the others and one vector read', async () => {
    const f = fixture(target);
    for (let i = 0; i < 316; i++) f.spore(`s${String(i).padStart(4, '0')}`, `spore ${i}`);
    await f.settle(T);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    f.reads.length = 0;
    f.spore('s9999', 'one more spore');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    const phases: EmbeddingStep['phase'][] = [];
    for (let i = 0; i < operationSteps(316) + 1; i++) {
      const { phase, processed } = await f.step(T);
      phases.push(phase);
      if (processed === 0) break;
    }
    expect(phases).toEqual([...Array<EmbeddingStep['phase']>(operationSteps(316)).fill('hubness'), 'settled']);
    expect(f.reads).toEqual([[(f.sqlite.query("SELECT id FROM embedding_receipts WHERE record_id = 's9999'").get() as { id: string }).id]]);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(await f.work(T)).toBe(false);
  });

  test('a removed spore leaves the calibration after its vector is deleted from the store', async () => {
    const f = fixture(target);
    for (let i = 0; i < 12; i++) f.spore(`s${i}`, `spore ${i}`);
    await f.settle(T);
    const gone = f.sqlite.query('SELECT id, type, record_id AS recordId, revision FROM embedding_receipts WHERE id = ?').get(f.current()[3]!) as { id: string; type: 'spore'; recordId: string; revision: string };
    await f.native.delete(SCOPE, [gone]);
    f.index?.apply();
    expect(await f.native.get(SCOPE, [gone.id])).toEqual([]);
    f.sqlite.run("UPDATE spores SET status = 'superseded' WHERE project_id = 'p' AND id = ?", [gone.recordId]);
    expect(await f.work(T)).toBe(true);
    expect(hubnessSteps(await f.settle(T))).toBe(1);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(await f.work(T)).toBe(false);
  });

  test('a step that read a page another step has since committed writes nothing, so no distance is applied twice', async () => {
    const f = fixture(target);
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    f.spore('s999', 'the spore that joins');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    // The parked step starts the operation, then parks at its first page's commit.
    f.commitPause.arm(2);
    const parked = f.step(T);
    await f.commitPause.reached;
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    f.commitPause.release();
    const late = await parked;
    expect(await f.settle(T)).toEqual(['hubness', 'settled']);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(late).toEqual({ phase: 'hubness', processed: 1 });
    expect(await f.work(T)).toBe(false);
  });

  test('a step that parked before its page commit, while another step finished the operation, writes nothing', async () => {
    const f = fixture(target);
    for (let i = 0; i < 60; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    f.spore('s999', 'the spore that joins');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    f.commitPause.arm();
    const parked = f.step(T);
    await f.commitPause.reached;
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    f.commitPause.release();
    const late = await parked;
    expect(await f.settle(T)).toEqual(['settled']);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(late).toEqual({ phase: 'hubness', processed: 0 });
    expect(await f.work(T)).toBe(false);
  });

  test('two steps that both start an operation start it once', async () => {
    const f = fixture(target);
    for (let i = 0; i < 60; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    f.sqlite.run("UPDATE spores SET content = 'revised' WHERE project_id = 'p' AND id = 's007'");
    expect((await f.step(T)).phase).toBe('stale');
    f.index?.apply();
    expect((await f.step(T)).phase).toBe('orphans');
    f.index?.apply();
    f.commitPause.arm();
    const parked = f.step(T);
    await f.commitPause.reached;
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    f.commitPause.release();
    const late = await parked;
    // The leaving operation's last page, then the joining operation's two pages: no step repeats a page.
    expect(await f.settle(T)).toEqual(['hubness', 'hubness', 'hubness', 'settled']);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(late).toEqual({ phase: 'hubness', processed: 0 });
    expect(await f.work(T)).toBe(false);
  });

  test('calibration work stays pending between the steps of an operation, so the next run takes it up', async () => {
    const f = fixture(target);
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    f.spore('s999', 'the spore that joins');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    expect(f.members().some((m) => m.state === 1)).toBe(true);
    expect(await f.work(T)).toBe(true);
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    expect(await f.work(T)).toBe(true);
    expect(await f.settle(T)).toEqual(['hubness', 'settled']);
    expect(await f.work(T)).toBe(false);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('a spore whose vector the store does not yet return does not hold a removed spore in the calibration', async () => {
    const f = fixture(target);
    for (let i = 0; i < 12; i++) f.spore(`s${String(i).padStart(2, '0')}`, `spore ${i}`);
    await f.settle(T);
    f.spore('s99', 'not yet visible');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    const hidden = (f.sqlite.query("SELECT id FROM embedding_receipts WHERE record_id = 's99'").get() as { id: string }).id;
    const native = f.context.vectors;
    f.context.vectors = { ...native, get: async (scope, ids) => (await native.get(scope, ids)).filter((v) => v.id !== hidden) };
    const gone = f.current().find((id) => id !== hidden)!;
    f.sqlite.run("UPDATE spores SET status = 'superseded' WHERE project_id = 'p' AND id = (SELECT record_id FROM embedding_receipts WHERE id = ?)", [gone]);
    for (let i = 0; i < 3; i++) { await f.settle(T + i * C); f.index?.apply(); }
    expect(f.members().map((m) => m.id)).not.toContain(gone);
    expect(f.members().map((m) => m.id)).not.toContain(hidden);
    expect(f.members().every((m) => m.state === 0 && m.n === f.members().length - 1)).toBe(true);
    expect(await f.work(T + 3 * C)).toBe(true);
    f.context.vectors = native;
    await f.settle(T + 3 * C);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('while calibration is built or extended over several operations, no receipt publishes statistics over fewer than all other spores', async () => {
    const f = fixture(target);
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    await f.expectExact();
    const published = () => new Map((f.sqlite.query("SELECT id, neighbor_mean, neighbor_std FROM embedding_receipts WHERE type = 'spore' AND ready = 1").all() as
      Array<{ id: string; neighbor_mean: number | null; neighbor_std: number | null }>).map((r) => [r.id, [r.neighbor_mean, r.neighbor_std] as const]));
    const same = (a: readonly [number | null, number | null], b: readonly [number | null, number | null]) =>
      (a[0] === null ? b[0] === null : b[0] !== null && Math.abs(a[0] - b[0]) < 1e-12) && (a[1] === null ? b[1] === null : b[1] !== null && Math.abs(a[1] - b[1]) < 1e-12);
    /** Steps to settled; after every step each receipt holds what it held before or its statistics over every other spore. */
    const stepChecked = async (before: Map<string, readonly [number | null, number | null]>) => {
      const exact = await f.recompute();
      let steps = 0;
      for (;;) {
        const { processed } = await f.step(T);
        f.index?.apply();
        steps++;
        for (const [id, held] of published()) {
          const full = exact.get(id)!;
          const ok = same(held, before.get(id) ?? [null, null]) || same(held, [full.mean, full.std]);
          expect({ step: steps, id, ok }).toEqual({ step: steps, id, ok: true });
        }
        if (processed === 0) return steps;
      }
    };
    // The build after schema step 50: the membership record starts empty under receipts that carry full statistics.
    f.sqlite.run('DELETE FROM embedding_hubness_members');
    f.sqlite.run('UPDATE embedding_cursors SET hubness_count = NULL, hubness_cursor = NULL');
    const cleared = f.repaired();
    expect(await stepChecked(published())).toBeGreaterThan(6);
    await f.expectExact();
    // Fifty new spores join over three operations under the 120 already calibrated.
    for (let i = 0; i < 50; i++) f.spore(`n${String(i).padStart(3, '0')}`, `new spore ${i}`);
    for (let i = 0; i < 50; i++) expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    expect(await stepChecked(published())).toBeGreaterThan(6);
    await f.expectExact();
    expect(f.repaired()).toBe(cleared);
  });

  test('a spore added and one removed while an operation runs publish no statistics over the operation\'s own set', async () => {
    const f = fixture(target);
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`, `spore ${i}`);
    await f.settle(T);
    const published = () => new Map((f.sqlite.query("SELECT id, neighbor_mean, neighbor_std FROM embedding_receipts WHERE type = 'spore' AND ready = 1").all() as
      Array<{ id: string; neighbor_mean: number | null; neighbor_std: number | null }>).map((r) => [r.id, [r.neighbor_mean, r.neighbor_std] as const]));
    f.spore('y', 'joins first');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    const before = published();
    // The member count stays at the current count while the membership names a removed spore and misses a new one.
    f.sqlite.run("DELETE FROM spores WHERE project_id = 'p' AND id = 's000'");
    f.spore('z', 'arrives while y joins');
    expect((await f.step(T)).phase).toBe('missing');
    f.index?.apply();
    const exact = await f.recompute();
    // The removed spore's vector is deleted first, then y's operation takes its next page.
    expect(await f.step(T)).toEqual({ phase: 'orphans', processed: 1 });
    f.index?.apply();
    expect(await f.step(T)).toEqual({ phase: 'hubness', processed: 1 });
    expect(f.members().some((m) => m.state === 1)).toBe(true);
    const wrong = [...published()].filter(([id, held]) => {
      const full = exact.get(id);
      if (full === undefined) return false;
      const kept = before.get(id) ?? [null, null];
      const same = (x: number | null, y: number | null) => x === null ? y === null : y !== null && Math.abs(x - y) < 1e-12;
      return !(same(held[0], kept[0]) && same(held[1], kept[1])) && !(same(held[0], full.mean) && same(held[1], full.std));
    });
    expect(wrong).toEqual([]);
    await f.settle(T + C);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('spores whose embeddings end in zeros calibrate exactly against full-length ones', async () => {
    const f = fixture(target);
    const embed = f.context.provider.embed;
    f.context.provider = { ...f.context.provider, embed: async (text) => text.startsWith('short') ? [...(await embed(text)).slice(0, 5), 0, 0, 0] : embed(text) };
    for (let i = 0; i < 10; i++) f.spore(`s${i}`, `spore ${i}`);
    f.spore('t1', 'short one');
    f.spore('t2', 'short two');
    await f.settle(T);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('moments that no longer count every other member are recomputed in full', async () => {
    const f = fixture(target);
    for (let i = 0; i < 8; i++) f.spore(`s${i}`, `spore ${i}`);
    await f.settle(T);
    f.sqlite.run('UPDATE embedding_hubness_members SET n = n + 1 WHERE id = (SELECT MIN(id) FROM embedding_hubness_members)');
    expect(await f.work(T)).toBe(true);
    const phases = await f.settle(T);
    expect(hubnessSteps(phases)).toBe(2);
    await f.expectExact();
    expect(f.repaired()).toBe(8);
    expect(await f.work(T)).toBe(false);
  });

  test('a spore vector the store never returns is written again a bounded number of times, while calibration settles exactly over the others, then goes quiet', async () => {
    const f = fixture(target);
    for (let i = 0; i < 12; i++) f.spore(`s${String(i).padStart(2, '0')}`, `spore ${i}`);
    await f.settle(T);
    await f.expectExact();
    const lost = losing(f, 'lost');
    f.spore('lost', 'a spore whose vector write is lost');
    f.spore('beside', 'a spore added beside it');
    const missing = (now: number) => missingSporeVectors(f.db, 'p', now);
    // Waited on until the bound: its write may still be applied, so no statistics publish over a set that lacks it.
    await f.settle(T);
    expect(lost.writes).toBe(1);
    expect(receiptOf(f, 'beside')!.neighbor_mean).toBeNull();
    expect(await f.work(T + LOST - 1)).toBe(true);
    expect(await missing(T + LOST - 1)).toEqual({ retrying: 0, abandoned: 0 });
    for (let attempt = 1; attempt <= VECTOR_REWRITE_LIMIT; attempt++) {
      const now = T + attempt * LOST;
      // Taken as lost: its receipt goes back through the write path, and the others' statistics publish without it.
      const phases = await f.settle(now);
      expect(receiptOf(f, 'beside')!.neighbor_mean).not.toBeNull();
      expect({ attempt, steps: phases.length <= 5 }).toEqual({ attempt, steps: true });
      expect(lost.writes).toBe(1 + attempt);
      expect(receiptOf(f, 'lost')).toMatchObject({ ready: 1, rewrites: attempt, neighbor_mean: null });
      expect(f.current()).not.toContain(receiptOf(f, 'lost')!.id);
      await f.expectExact();
      expect(await missing(now)).toEqual({ retrying: 1, abandoned: 0 });
      // Each new write is looked for until the bound from that write.
      expect(await f.work(now + LOST - 1)).toBe(true);
    }
    // The rewrite bound is spent: the vector is not written again, the spore is reported, and the job is quiet.
    const spent = T + (VECTOR_REWRITE_LIMIT + 1) * LOST;
    expect(await f.work(spent - 1)).toBe(true);
    expect(await f.work(spent)).toBe(false);
    expect((await f.settle(spent)).length).toBeLessThanOrEqual(2);
    expect(await f.work(spent)).toBe(false);
    await f.settle(spent + 100 * LOST);
    expect(await f.work(spent + 100 * LOST)).toBe(false);
    expect(lost.writes).toBe(1 + VECTOR_REWRITE_LIMIT);
    expect(receiptOf(f, 'lost')).toMatchObject({ ready: 1, rewrites: VECTOR_REWRITE_LIMIT });
    expect(await missing(spent)).toEqual({ retrying: 0, abandoned: 1 });
    expect(embeddingRunReport({ processed: 0, phase: 'settled', missing: await missing(spent) }).summary).toBe(
      `Processed 0 embedding records; settled. 1 spore is left out of relevance calibration: the vector store never returned its vector, even after it was written again ${VECTOR_REWRITE_LIMIT} times.`);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('a lost spore vector that its rewrite makes visible joins incrementally, and calibration is exact over every spore', async () => {
    const f = fixture(target);
    for (let i = 0; i < 60; i++) f.spore(`s${String(i).padStart(2, '0')}`, `spore ${i}`);
    await f.settle(T);
    const lost = losing(f, 'lost', 1);
    f.spore('lost', 'a spore whose first vector write is lost');
    await f.settle(T);
    expect(await f.work(T + LOST - 1)).toBe(true);
    const phases = await f.settle(T + LOST);
    expect(f.members().map((m) => m.id)).toContain(receiptOf(f, 'lost')!.id);
    expect(lost.writes).toBe(2);
    // One joining operation over the 60 settled members: no full recompute.
    expect(hubnessSteps(phases)).toBe(operationSteps(60));
    expect(receiptOf(f, 'lost')).toMatchObject({ ready: 1, rewrites: 0 });
    expect(f.current()).toContain(receiptOf(f, 'lost')!.id);
    await f.expectExact();
    expect(f.repaired()).toBe(0);
    expect(await f.work(T + LOST)).toBe(false);
    expect(await missingSporeVectors(f.db, 'p', T + LOST)).toEqual({ retrying: 0, abandoned: 0 });
  });

  test('a spore vector the store returns three minutes after its write joins without being written again', async () => {
    const f = fixture(target);
    for (let i = 0; i < 12; i++) f.spore(`s${String(i).padStart(2, '0')}`, `spore ${i}`);
    await f.settle(T);
    const slow = losing(f, 'slow', 0);
    let clock = T;
    const inner = f.context.vectors;
    f.context.vectors = { ...inner, get: async (scope, ids) => (await inner.get(scope, ids)).filter((v) => v.metadata.record_id !== 'slow' || clock >= T + 3 * MINUTE) };
    f.spore('slow', 'a spore whose vector is slow to appear');
    for (const minutes of [0, 1, 2]) {
      clock = T + minutes * MINUTE;
      await f.settle(clock);
      expect(await f.work(clock)).toBe(true);
    }
    clock = T + 3 * MINUTE;
    await f.settle(clock);
    await f.expectExact();
    expect(f.current()).toContain(receiptOf(f, 'slow')!.id);
    expect(await f.work(clock)).toBe(false);
    for (const later of [LOST, 2 * LOST, 10 * LOST]) {
      clock = T + later;
      await f.settle(clock);
      expect(await f.work(clock)).toBe(false);
    }
    expect(slow.writes).toBe(1);
    expect(receiptOf(f, 'slow')).toMatchObject({ ready: 1, rewrites: 0 });
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });

  test('a left-out spore that is removed has its vector deleted and is never written again', async () => {
    const f = fixture(target);
    for (let i = 0; i < 12; i++) f.spore(`s${String(i).padStart(2, '0')}`, `spore ${i}`);
    await f.settle(T);
    const lost = losing(f, 'lost');
    f.spore('lost', 'a spore whose vector write is lost');
    await f.settle(T);
    await f.settle(T + LOST);
    expect(receiptOf(f, 'lost')).toMatchObject({ ready: 1, rewrites: 1 });
    f.sqlite.run("DELETE FROM spores WHERE project_id = 'p' AND id = 'lost'");
    await f.settle(T + LOST + 1);
    expect(receiptOf(f, 'lost')).toMatchObject({ ready: -1, rewrites: 1 });
    await f.settle(T + 3 * LOST);
    expect(receiptOf(f, 'lost')).toBeNull();
    expect(lost.writes).toBe(2);
    expect(await f.work(T + 3 * LOST)).toBe(false);
    expect(await missingSporeVectors(f.db, 'p', T + 3 * LOST)).toEqual({ retrying: 0, abandoned: 0 });
    await f.expectExact();
    expect(f.repaired()).toBe(0);
  });
});

test('an embedding run reports the spores its last step found left out of relevance calibration', async () => {
  const steps = [
    { held: true, phase: 'missing', processed: 1, missing: { retrying: 1, abandoned: 0 } },
    { held: true, phase: 'settled', processed: 0, missing: { retrying: 1, abandoned: 2 } },
  ];
  const result = await runEmbeddingSteps(async () => steps.shift()!, new AbortController().signal, Date.now() + 10 * MINUTE);
  expect(result).toEqual({ processed: 1, phase: 'settled', missing: { retrying: 1, abandoned: 2 } });
  expect(embeddingRunReport(result).summary).toBe('Processed 1 embedding records; settled.'
    + ' 1 spore is left out of relevance calibration: the vector store has not returned its vector, so it is being written again.'
    + ` 2 spores are left out of relevance calibration: the vector store never returned their vectors, even after they were written again ${VECTOR_REWRITE_LIMIT} times.`);
  const quiet = await runEmbeddingSteps(async () => ({ held: true, phase: 'settled', processed: 0, missing: { retrying: 0, abandoned: 0 } }), new AbortController().signal, Date.now() + 10 * MINUTE);
  expect(embeddingRunReport(quiet).summary).toBe('Processed 0 embedding records; settled.');
});
