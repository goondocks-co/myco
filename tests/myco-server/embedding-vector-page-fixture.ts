import { expect } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { calibrationHasWork } from '@myco-server-worker/db/embeddings/calibration.js';
import { reconcileHubness } from '@myco-server-worker/core/embedding/hubness.js';
import type { EmbeddingContext } from '@myco-server-worker/core/embedding/reconcile.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '@myco-server-worker/constants.js';
import { prepareEmbeddingDue } from '@myco-server-worker/db/embeddings/work.js';
import { memoryBlobStore, type MemoryBlobStore } from './helpers/fixtures.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';

export const NOW = 10 ** 12;
export const MODEL = 'm';
export const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `s${String(from + i).padStart(4, '0')}`);
export const values = (id: string) => { const n = Number(id.slice(1)); return Array.from({ length: 8 }, (_, j) => Math.sin(n * 0.17 + j * 0.31) + Math.cos(n * 0.07 - j)); };
export const context = (db: RelationalStore, blobs: MemoryBlobStore): EmbeddingContext =>
  ({ db, blobs, provider: { modelKey: MODEL }, vectors: { get: async (_: unknown, wanted: readonly string[]) => wanted.map((id) => ({ id, values: values(id) })) } }) as unknown as EmbeddingContext;

export async function addSpores(db: RelationalStore, spores: readonly string[]) {
  await db.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
  for (const id of spores) await db.prepare("INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('p',?,'a',?,'decision',1)").bind(id, `spore ${id}`).run();
  await db.prepare(`INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
    SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p' AND record_id IN (SELECT value FROM json_each(?))`).bind(MODEL, JSON.stringify(spores)).run();
  while ((await prepareEmbeddingDue(db, 'p', MODEL)).more);
}
export const dropReceipts = (db: RelationalStore, spores: readonly string[]) =>
  db.prepare("DELETE FROM embedding_receipts WHERE project_id='p' AND id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(spores)).run();

/** Steps until one does nothing, answering it. */
export async function settle(db: RelationalStore, blobs: MemoryBlobStore, now = NOW) {
  for (let i = 0; i < 800; i++) {
    const step = await reconcileHubness(context(db, blobs), 'p', now);
    if (step.processed === 0) return step;
  }
  throw new Error('calibration did not settle');
}

export const moments = async (db: RelationalStore) => (await db.prepare('SELECT id,state,n,mean,m2 FROM embedding_hubness_members ORDER BY id').all()).results; export const statistics = async (db: RelationalStore) => (await db.prepare("SELECT id,neighbor_mean,neighbor_std FROM embedding_receipts WHERE project_id='p' ORDER BY id").all()).results; export const results = async (db: RelationalStore) => ({ moments: await moments(db), statistics: await statistics(db) });
export const count = async (db: RelationalStore, where: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${where}`).first<{ n: number }>())!.n; export const pageKeys = async (db: RelationalStore) => ((await db.prepare('SELECT object_key FROM embedding_vector_pages ORDER BY page_id').all<{ object_key: string }>()).results).map((r) => r.object_key); export const inlineBytes = async (db: RelationalStore) => (await db.prepare("SELECT id,vector FROM embedding_hubness_members WHERE state=0 ORDER BY id").all()).results;

/** Steps calibration under `model` with reads refused until every page is released, its work reported the whole way. */
export async function retireWithoutReading(db: RelationalStore, blobs: MemoryBlobStore, model: string) {
  const refused = () => { throw new Error('retirement computed a distance'); };
  const held = { ...blobs, get: refused, head: refused } as unknown as MemoryBlobStore;
  const steps = { ...context(db, held), provider: { modelKey: model }, vectors: { get: refused } } as unknown as EmbeddingContext;
  for (let i = 0; i < 40; i++) {
    const pages = await count(db, 'embedding_vector_pages');
    const work = await calibrationHasWork(db, 'p', model, NOW);
    if (pages === 0 && !work) return;
    expect(work).toBe(true);
    await reconcileHubness(steps, 'p', NOW);
  }
  throw new Error('retirement did not finish');
}
export const refusingPuts = () => { const blobs = memoryBlobStore(); blobs.put = async () => { throw new Error('refused'); }; return blobs; };

/** Calibrate `first`, then `then` a further change, with `blobs` as the store. */
export async function scenario(db: RelationalStore, blobs: MemoryBlobStore) {
  await addSpores(db, ids(0, 120));
  await settle(db, blobs);
  await addSpores(db, ids(120, 125));
  await settle(db, blobs);
  await dropReceipts(db, [ids(3, 4)[0]!, ids(55, 56)[0]!]);
  await settle(db, blobs);
  return results(db);
}

export async function unverifiedVectorPage(target: 'native' | 'd1'): Promise<void> {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        const get = blobs.get.bind(blobs);
        blobs.get = async (key, options) => {
          const held = await get(key, options);
          if (held === null) return null;
          const bytes = new Uint8Array(await new Response(held.body).arrayBuffer());
          bytes[bytes.byteLength - 1]! ^= 0xff;
          return { size: held.size, body: new Response(bytes).body! };
        };
        await addSpores(db, ids(0, 60));
        const step = await settle(db, blobs);
        expect(step).toEqual({ phase: 'vector-page', processed: 0 });
        expect(await count(db, "embedding_hubness_members WHERE vector='' OR page_id IS NOT NULL")).toBe(0);
        const [key] = await pageKeys(db);
        expect(blobs.objects.has(key!)).toBe(true);
        blobs.get = get;
        await calibrationHasWork(db, 'p', MODEL, NOW);
        const rest = await reconcileHubness(context(db, refusingPuts()), 'p', NOW + OBJECT_PUT_IN_FLIGHT_MS);
        expect(rest.processed).toBe(1);
        expect(await count(db, `object_releases WHERE physical='${key}'`)).toBe(1);
      });
}

export const vectorPageBreakages: Array<[string, (blobs: MemoryBlobStore, key: string) => void]> = [
  ['absent', (blobs, key) => { blobs.objects.delete(key); }],
  ['partial', (blobs, key) => { const o = blobs.objects.get(key)!; blobs.objects.set(key, { size: o.size, bytes: o.bytes.subarray(0, o.bytes.byteLength - 40) }); }],
  ['resized', (blobs, key) => { const o = blobs.objects.get(key)!; blobs.objects.set(key, { size: o.size - 40, bytes: o.bytes }); }],
  ['damaged', (blobs, key) => { const o = blobs.objects.get(key)!; const bytes = o.bytes.slice(); bytes[bytes.byteLength - 1]! ^= 0xff; blobs.objects.set(key, { size: o.size, bytes }); }],
];

export async function resumedVectorPage(target: 'native' | 'd1', breakPage: (blobs: MemoryBlobStore, key: string) => void): Promise<void> {
        let control: unknown;
        await withEmbeddingStore(target, async (db) => {
          const blobs = memoryBlobStore();
          await addSpores(db, ids(0, 60)); await settle(db, blobs);
          await addSpores(db, ids(60, 61)); await settle(db, blobs);
          control = await results(db);
        });
        await withEmbeddingStore(target, async (db) => {
          const blobs = memoryBlobStore();
          await addSpores(db, ids(0, 60));
          await settle(db, blobs);
          const [key] = await pageKeys(db);
          const whole = blobs.objects.get(key!)!;
          await addSpores(db, ids(60, 61));
          const before = await statistics(db);
          breakPage(blobs, key!);
          expect(await settle(db, blobs)).toEqual({ phase: 'vector-page', processed: 0 });
          expect(await statistics(db)).toEqual(before);
          expect(await count(db, 'embedding_hubness_members WHERE state=0 AND n<>59')).toBe(0);
          expect(await calibrationHasWork(db, 'p', MODEL, NOW)).toBe(true);
          blobs.objects.set(key!, whole);
          await settle(db, blobs);
          expect(await results(db)).toEqual(control as Awaited<ReturnType<typeof results>>);
        });
}
