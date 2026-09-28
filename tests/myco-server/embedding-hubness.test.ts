import { afterEach, describe, expect, test } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { indexFixture } from './helpers/vector-index.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { cloudflareVectorStore } from '../../packages/myco-server/src/platform/cloudflare/vectors.js';
import { reconcileEmbedding, type EmbeddingContext, type EmbeddingStep } from '../../packages/myco-server/src/core/embedding/reconcile.js';
import { CURRENT_SPORE_VECTORS } from '../../packages/myco-server/src/core/embedding/hubness.js';
import { VECTOR_DELETE_CONFIRM_MS as C, type EmbeddingProvider } from '../../packages/myco-server/src/core/embedding/provider.js';
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
});
