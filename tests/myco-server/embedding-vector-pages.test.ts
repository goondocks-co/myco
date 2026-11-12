import { describe, expect, test } from 'bun:test';
import { calibrationHasWork, calibrationView, commitVectorPageSeal } from '@myco-server-worker/db/embeddings/calibration.js';
import { reconcileHubness } from '@myco-server-worker/core/embedding/hubness.js';
import { VECTOR_LOST_MS } from '@myco-server-worker/core/embedding/provider.js';
import type { EmbeddingContext } from '@myco-server-worker/core/embedding/reconcile.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '@myco-server-worker/constants.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { beginVectorPage, reclaimVectorPages, VECTOR_PAGE } from '@myco-server-worker/db/embeddings/vector-pages.js';
import { prepareEmbeddingDue } from '@myco-server-worker/db/embeddings/work.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { addSpores, context, count, dropReceipts, ids, inlineBytes, MODEL, NOW, pageKeys, refusingPuts, results, retireWithoutReading, resumedVectorPage, scenario, settle, unverifiedVectorPage, vectorPageBreakages } from './embedding-vector-page-fixture.js';


for (const target of ['native', 'd1'] as const) {
  describe(`calibration vector pages (${target})`, () => {
    test('moments and statistics match a calibration that never moved its vectors, through joins and leaves', async () => {
      let control: unknown;
      await withEmbeddingStore(target, async (db) => { control = await scenario(db, refusingPuts()); });
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        expect(await scenario(db, blobs)).toEqual(control as Awaited<ReturnType<typeof results>>);
        expect(await count(db, "embedding_hubness_members WHERE vector='' AND page_id IS NOT NULL")).toBeGreaterThanOrEqual(95);
        expect(await count(db, "embedding_hubness_members WHERE page_id IS NULL AND state=0")).toBeLessThan(50);
        expect(blobs.objects.size).toBeGreaterThanOrEqual(2);
      });
    }, 120_000);

    test('a walk of a sealed population reads one range per stored page', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 100));
        await settle(db, blobs);
        expect(await count(db, 'embedding_vector_pages')).toBe(2);
        blobs.gets.length = 0;
        await addSpores(db, ids(100, 101));
        await settle(db, blobs);
        expect(new Set(blobs.gets.map((g) => g.key)).size).toBe(2);
        expect(blobs.gets.length).toBeLessThanOrEqual(3);
      });
    }, 60_000);

    if (target === 'd1') test('a page that does not verify leaves every row holding its bytes, and is released once it cannot be in flight', () => unverifiedVectorPage(target), 60_000);

    test('a commit that loses its fence leaves the rows holding their bytes', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        const put = blobs.put.bind(blobs);
        await addSpores(db, ids(0, 60));
        await settle(db, refusingPuts());
        blobs.put = async (key, value, options) => {
          await db.prepare("UPDATE embedding_cursors SET hubness_token='another' WHERE project_id='p'").run();
          return put(key, value, options);
        };
        expect((await reconcileHubness(context(db, blobs), 'p', NOW)).processed).toBe(0);
        expect(await count(db, "embedding_hubness_members WHERE vector='' OR page_id IS NOT NULL")).toBe(0);
        expect(await count(db, "embedding_vector_pages WHERE state=0 AND object_key IN (SELECT value FROM json_each(?1))".replace('?1', `'${JSON.stringify([...blobs.objects.keys()])}'`))).toBe(1);
      });
    }, 60_000);

    if (target === 'd1') for (const [fault, breakPage] of vectorPageBreakages) test(`a page that is ${fault} answers a retryable outcome, changes nothing, and resumes exactly once it returns`, () => resumedVectorPage(target, breakPage), 120_000);

    test('a store failure is retried without marking the page lost', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        await addSpores(db, ids(60, 61));
        blobs.get = async () => { throw new Error('store is unwell'); };
        expect(await settle(db, blobs)).toEqual({ phase: 'vector-page', processed: 0 });
        expect(await count(db, 'embedding_vector_pages WHERE missing_at IS NOT NULL')).toBe(0);
      });
    }, 60_000);

    test('a page still gone after the wait is lost, and the model is rebuilt exactly from the vector store', async () => {
      let control: unknown;
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 61));
        await settle(db, blobs);
        control = await results(db);
      });
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        await addSpores(db, ids(60, 61));
        const [key] = await pageKeys(db);
        blobs.objects.delete(key!);
        expect((await settle(db, blobs)).phase).toBe('vector-page');
        expect(await count(db, 'embedding_vector_pages WHERE missing_at IS NOT NULL')).toBe(1);
        const later = NOW + VECTOR_LOST_MS;
        await settle(db, blobs, later);
        expect(await results(db)).toEqual(control as Awaited<ReturnType<typeof results>>);
      });
    }, 120_000);

    test('a page whose members have all left is handed to the release owner', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        const [key] = await pageKeys(db);
        await dropReceipts(db, ids(0, 20));
        await settle(db, blobs);
        expect(await count(db, 'embedding_vector_pages WHERE live=30')).toBe(1);
        await dropReceipts(db, ids(20, 50));
        await settle(db, blobs);
        expect(await pageKeys(db)).toEqual([]);
        expect(await count(db, `object_releases WHERE physical='${key}'`)).toBe(1);
      });
    }, 120_000);

    for (const [who, projectId, modelKey] of [['the same model', 'p', MODEL], ['another Project', 'q', 'other']] as const) {
      test(`a sealer whose page was released and replaced for ${who} clears no row against an object it did not verify`, async () => {
        await withEmbeddingStore(target, async (db) => {
          const blobs = memoryBlobStore();
          await addSpores(db, ids(0, 60));
          await settle(db, refusingPuts());
          await reclaimVectorPages(db, 'p', NOW, NOW);
          const held = await inlineBytes(db);
          const put = blobs.put.bind(blobs);
          let replacement = 0;
          blobs.put = async (key, value, options) => {
            blobs.put = put;
            await reclaimVectorPages(db, 'p', NOW, NOW + OBJECT_PUT_IN_FLIGHT_MS);
            replacement = await beginVectorPage(db, projectId, modelKey, `vector-pages/${projectId}/not-yet-written`, options!.size!, NOW + OBJECT_PUT_IN_FLIGHT_MS);
            return put(key, value, options);
          };
          expect(await reconcileHubness(context(db, blobs), 'p', NOW)).toEqual({ phase: 'hubness', processed: 0 });
          expect(await inlineBytes(db)).toEqual(held);
          expect(await count(db, 'embedding_hubness_members WHERE page_id IS NOT NULL')).toBe(0);
          expect(await db.prepare('SELECT state,live FROM embedding_vector_pages WHERE page_id=?').bind(replacement).first()).toEqual({ state: VECTOR_PAGE.writing, live: 0 });
        });
      }, 120_000);
    }

    test('a page row holding the same id under another object is never sealed in its place', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, refusingPuts());
        await reclaimVectorPages(db, 'p', NOW, NOW);
        const held = await inlineBytes(db);
        const put = blobs.put.bind(blobs);
        blobs.put = async (key, value, options) => {
          blobs.put = put;
          const { page_id } = (await db.prepare('SELECT page_id FROM embedding_vector_pages').first<{ page_id: number }>())!;
          await db.prepare('DELETE FROM embedding_vector_pages WHERE page_id=?').bind(page_id).run();
          await db.prepare("INSERT INTO embedding_vector_pages(page_id,project_id,model_key,object_key,size,created_at) VALUES(?,'p',?,'vector-pages/p/other',1,?)").bind(page_id, MODEL, NOW).run();
          return put(key, value, options);
        };
        expect((await reconcileHubness(context(db, blobs), 'p', NOW)).processed).toBe(0);
        expect(await inlineBytes(db)).toEqual(held);
        expect(await count(db, "embedding_vector_pages WHERE object_key='vector-pages/p/other' AND state=0 AND live=0")).toBe(1);
      });
    }, 120_000);

    test('a released page id is never given to a later page', async () => {
      await withEmbeddingStore(target, async (db) => {
        const first = await beginVectorPage(db, 'p', MODEL, 'vector-pages/p/first', 1, NOW);
        expect(await reclaimVectorPages(db, 'p', NOW, NOW)).toBe(1);
        expect(await beginVectorPage(db, 'p', MODEL, 'vector-pages/p/second', 1, NOW)).toBeGreaterThan(first);
      });
    }, 120_000);

    test('an object landing after its released page was already deleted goes back to the release owner', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, refusingPuts());
        await reclaimVectorPages(db, 'p', NOW, NOW);
        const put = blobs.put.bind(blobs);
        let written = '';
        blobs.put = async (key, value, options) => {
          blobs.put = put;
          written = key;
          await reclaimVectorPages(db, 'p', NOW, NOW + OBJECT_PUT_IN_FLIGHT_MS);
          await drainObjectReleases({ db, blobs }, NOW + 2 * OBJECT_PUT_IN_FLIGHT_MS);
          return put(key, value, options);
        };
        expect((await reconcileHubness(context(db, blobs), 'p', NOW)).processed).toBe(0);
        expect(blobs.objects.has(written)).toBe(true);
        expect(await count(db, `object_releases WHERE physical='${written}'`)).toBe(1);
        await drainObjectReleases({ db, blobs }, NOW + 3 * OBJECT_PUT_IN_FLIGHT_MS);
        expect(blobs.objects.has(written)).toBe(false);
      });
    }, 120_000);

    test('every member departing retires the memberships and releases their pages, with no distance computed', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        const [key] = await pageKeys(db);
        await dropReceipts(db, ids(0, 60));
        await retireWithoutReading(db, blobs, MODEL);
        expect(await count(db, 'embedding_hubness_members')).toBe(0);
        expect(await count(db, `object_releases WHERE physical='${key}'`)).toBe(1);
      });
    }, 120_000);

    test('one current vector left retires the rest, and a second vector calibrates exactly', async () => {
      let control: unknown;
      await withEmbeddingStore(target, async (db) => {
        await addSpores(db, ['s0000', 's0060']);
        await settle(db, memoryBlobStore());
        control = await results(db);
      });
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        const [key] = await pageKeys(db);
        await dropReceipts(db, ids(1, 60));
        await retireWithoutReading(db, blobs, MODEL);
        expect(await count(db, 'embedding_hubness_members')).toBe(0);
        expect(await count(db, `object_releases WHERE physical='${key}'`)).toBe(1);
        await db.prepare('UPDATE embedding_receipts SET neighbor_mean=NULL,neighbor_std=NULL').run();
        await addSpores(db, ['s0060']);
        await settle(db, blobs);
        expect(await results(db)).toEqual(control as Awaited<ReturnType<typeof results>>);
      });
    }, 120_000);

    for (const current of [0, 1]) {
      test(`a new model with ${current} current vectors retires the old model's members and pages, with no distance computed`, async () => {
        await withEmbeddingStore(target, async (db) => {
          const blobs = memoryBlobStore();
          await addSpores(db, ids(0, 60));
          await settle(db, blobs);
          const [key] = await pageKeys(db);
          if (current === 1) {
            await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
              SELECT project_id,'new',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p' AND record_id='s0000'`).run();
            while ((await prepareEmbeddingDue(db, 'p', 'new')).more);
          }
          await retireWithoutReading(db, blobs, 'new');
          expect(await count(db, 'embedding_hubness_members')).toBe(0);
          expect(await count(db, `object_releases WHERE physical='${key}'`)).toBe(1);
        });
      }, 120_000);
    }

    test('work remains while a full page is held in the database, and rest holds under a page', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 50));
        await settle(db, refusingPuts());
        expect(await calibrationHasWork(db, 'p', MODEL, NOW)).toBe(true);
        await settle(db, blobs);
        await addSpores(db, ids(50, 90));
        await settle(db, blobs);
        expect(await count(db, 'embedding_vector_pages WHERE state=1')).toBe(1);
        expect(await calibrationHasWork(db, 'p', MODEL, NOW + OBJECT_PUT_IN_FLIGHT_MS * 2)).toBe(true);
        await reconcileHubness(context(db, blobs), 'p', NOW + OBJECT_PUT_IN_FLIGHT_MS * 2);
        expect(await count(db, 'embedding_vector_pages WHERE state=0')).toBe(0);
        expect(await calibrationHasWork(db, 'p', MODEL, NOW + OBJECT_PUT_IN_FLIGHT_MS * 2)).toBe(false);
      });
    }, 60_000);

    test('a late upload whose verification fails is still handed to the release owner', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, refusingPuts());
        await reclaimVectorPages(db, 'p', NOW, NOW);
        await drainObjectReleases({ db, blobs }, NOW + 2 * OBJECT_PUT_IN_FLIGHT_MS);
        const put = blobs.put.bind(blobs);
        const get = blobs.get.bind(blobs);
        let written = '';
        blobs.put = async (key, value, options) => {
          blobs.put = put;
          written = key;
          await reclaimVectorPages(db, 'p', NOW, NOW + OBJECT_PUT_IN_FLIGHT_MS);
          await drainObjectReleases({ db, blobs }, NOW + 2 * OBJECT_PUT_IN_FLIGHT_MS);
          return put(key, value, options);
        };
        blobs.get = async () => { throw new Error('verification read interrupted'); };
        expect(await reconcileHubness(context(db, blobs), 'p', NOW)).toEqual({ phase: 'vector-page', processed: 0 });
        blobs.get = get;
        expect(await count(db, "object_releases WHERE physical='" + written + "'")).toBe(1);
        expect((await inlineBytes(db)).every((row) => row.vector !== '')).toBe(true);
        await drainObjectReleases({ db, blobs }, NOW + 4 * OBJECT_PUT_IN_FLIGHT_MS);
        expect(blobs.objects.has(written)).toBe(false);
      });
    }, 60_000);

    test('a seal the page cannot make leaves the member bytes and the cursor as they were', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        const page = (await db.prepare('SELECT page_id,object_key FROM embedding_vector_pages WHERE state=1 LIMIT 1').first<{ page_id: number; object_key: string }>())!;
        const slot = (await db.prepare('SELECT page_offset,page_length FROM embedding_hubness_members WHERE page_id=? ORDER BY id LIMIT 1').bind(page.page_id).first<{ page_offset: number; page_length: number }>())!;
        await dropReceipts(db, ['s0000']);
        await settle(db, blobs);
        await addSpores(db, ['s0000']);
        await settle(db, blobs);
        const member = () => db.prepare("SELECT vector,page_id FROM embedding_hubness_members WHERE id='s0000'").first();
        const before = await member();
        expect(before!.page_id).toBeNull();
        const view = await calibrationView(db, 'p', MODEL);
        const refused = await commitVectorPageSeal(db, 'p', MODEL, view.token, view.population.revision, { id: page.page_id, objectKey: page.object_key }, [['s0000', slot.page_offset, slot.page_length]]);
        expect(refused).toBe(false);
        expect(await member()).toEqual(before);
        expect((await calibrationView(db, 'p', MODEL)).token).toBe(view.token);
      });
    }, 60_000);

    test('a switch with fewer than two new vectors keeps the current model\'s members until it ends', async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        const members = await count(db, `embedding_hubness_members WHERE model_key='${MODEL}'`);
        expect(members).toBe(60);
        const switched = { ...context(db, blobs), provider: { modelKey: 'next' }, retain: [MODEL] } as unknown as EmbeddingContext;
        expect(await calibrationHasWork(db, 'p', 'next', NOW, [MODEL])).toBe(false);
        expect(await reconcileHubness(switched, 'p', NOW)).toEqual({ phase: 'settled', processed: 0 });
        expect(await count(db, `embedding_hubness_members WHERE model_key='${MODEL}'`)).toBe(members);
        expect(await calibrationHasWork(db, 'p', 'next', NOW)).toBe(true);
        await reconcileHubness({ ...switched, retain: [] } as EmbeddingContext, 'p', NOW);
        expect(await count(db, `embedding_hubness_members WHERE model_key='${MODEL}'`)).toBeLessThan(members);
      });
    }, 60_000);

    for (const next of ['next', 'zz']) test(`a kept model does not hide another model's leftover members from calibration of ${next}`, async () => {
      await withEmbeddingStore(target, async (db) => {
        const blobs = memoryBlobStore();
        await addSpores(db, ids(0, 60));
        await settle(db, blobs);
        await db.prepare("INSERT INTO embedding_hubness_members(project_id,model_key,id,state,vector) VALUES('p','z','left-over',0,'')").run();
        const members = await count(db, `embedding_hubness_members WHERE model_key='${MODEL}'`);
        expect(await calibrationHasWork(db, 'p', next, NOW, [MODEL])).toBe(true);
        expect(await reconcileHubness({ ...context(db, blobs), provider: { modelKey: next }, retain: [MODEL] } as unknown as EmbeddingContext, 'p', NOW)).toEqual({ phase: 'hubness', processed: 1 });
        expect(await count(db, "embedding_hubness_members WHERE model_key='z'")).toBe(0);
        expect(await count(db, `embedding_hubness_members WHERE model_key='${MODEL}'`)).toBe(members);
        expect(await calibrationHasWork(db, 'p', next, NOW, [MODEL])).toBe(false);
      });
    }, 60_000);

  });
}
