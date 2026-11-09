import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { createProject } from '@myco-server-worker/read/sessions.js';
import type { BlobListOptions, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { DRAIN_PAGE, drainObjectReleases, objectReleaseBacklogged, acquireRecoveryHold, recordObservedCandidates, resetRecoveryLedger } from '@myco-server-worker/core/object-release.js';
import { OBJECT_RECONCILE_PASS_MS, OBJECT_WALK_QUARANTINE_MS, reconcileStoredObjects } from '@myco-server-worker/db/storage/object-reconciliation.js';
import { RELEASE_PAGE } from '@myco-server-worker/db/storage/release-queue.js';
import { readDeploymentStorageUsage } from '@myco-server-worker/db/storage/usage.js';
import { diskBlobStore } from '@myco-server-worker/platform/bun/blobs.js';
import { memoryBlobStore, type MemoryBlobStore } from './helpers/fixtures.js';
import { withDocumentStores } from './helpers/document-stores.js';

const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - BLOB_RESERVATION_TTL_MS - 1);
const YOUNG = new Date(NOW - 1_000);
const key = (n: number) => n.toString(16).padStart(64, '0');
const generation = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const objectOf = (n: number) => blobObjectKey('project', key(n), generation(n));
const pageOf = (n: number) => `vector-pages/project/${generation(n)}`;

const env = (db: RelationalStore, blobs: MemoryBlobStore) => ({ db, blobs });
const seeded = (blobs: MemoryBlobStore, name: string, uploaded = AGED) => blobs.seed(name, { size: 1, uploaded });
async function register(db: RelationalStore, n: number, receivedAt = AGED.getTime()) {
  await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) VALUES('project',?,1,'text/plain','t',?,?)`)
    .bind(key(n), receivedAt, generation(n)).run();
}
const hold = (db: RelationalStore, n: number) => db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
  VALUES('project',?,?,'event','e','e','h','s',?,1,1,1)`).bind(key(n), generation(n), key(n)).run();
const journaled = async (db: RelationalStore) => (await db.prepare('SELECT physical FROM object_releases ORDER BY physical').all<{ physical: string }>()).results.map(r => r.physical);
const QUARANTINE = OBJECT_WALK_QUARANTINE_MS;
const NOTHING = { released: 0, ownerless: 0, vectorPages: 0 };
const walkFloor = async (db: RelationalStore) => (await db.prepare('SELECT armed_at FROM object_store_reconciliation WHERE slot=1').first<{ armed_at: number }>())!.armed_at;
const restartWalk = (db: RelationalStore) => db.prepare("UPDATE object_store_reconciliation SET after_key='',next_pass_at=0").run();
const walkPosition = (db: RelationalStore) => db.prepare('SELECT after_key,next_pass_at FROM object_store_reconciliation WHERE slot=1').first<{ after_key: string; next_pass_at: number }>();

describe('a store lists its keys in order', () => {
  it('a native store answers keys in byte order, resumes after a key, and leaves temporary files out', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-list-'));
    try {
      const blobs = diskBlobStore(root);
      for (const name of ['a-b/x', 'a/x', 'a/y', 'b', 'a/x.123.partial']) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), 'x');
      }
      const first = await blobs.list({ limit: 2 });
      expect(first.objects.map(o => o.key)).toEqual(['a-b/x', 'a/x']);
      expect(first.objects[0]!.uploaded.getTime()).toBeGreaterThan(0);
      expect(first.truncated).toBe(true);
      const rest = await blobs.list({ limit: 2, startAfter: 'a/x' });
      expect(rest.objects.map(o => o.key)).toEqual(['a/y', 'b']);
      expect(rest.truncated).toBe(false);
      expect((await blobs.list({ limit: 2, startAfter: 'b' })).objects).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('a hosted bucket lists through the target adapter', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', r2Buckets: ['BUCKET'] }));
    try {
      const bucket = await mf.getR2Bucket('BUCKET');
      for (const name of ['a/1', 'a/2', 'a/3']) await bucket.put(name, 'x');
      const { blobs } = serverEnvFromBindings({ MYCO_DB: {} as never, BUCKET: bucket as never, SOURCE_LIMIT: { limit: async () => ({ success: true }) } as never, TOKEN_LIMIT: { limit: async () => ({ success: true }) } as never });
      const page = await blobs.list({ limit: 2, startAfter: 'a/1' });
      expect(page.objects.map(o => o.key)).toEqual(['a/2', 'a/3']);
      expect(page.objects[0]!.uploaded).toBeInstanceOf(Date);
      expect((await blobs.list({ limit: 1 })).truncated).toBe(true);
    } finally { await mf.dispose(); }
  });

  it('the floor a hosted database seeds keeps objects its bucket held before migration', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], r2Buckets: ['BUCKET'] }));
    try {
      const db = await mf.getD1Database('DB');
      const bucket = await mf.getR2Bucket('BUCKET');
      await bucket.put(objectOf(1), 'held before this database existed');
      await bucket.put(pageOf(2), 'held before this database existed');
      await Bun.sleep(1_500);
      for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql: string) => db.prepare(sql)));
      await createProject(db as never, 'project', 'project', 1);
      await Bun.sleep(1_500);
      await bucket.put(objectOf(11), 'landed after the claim');
      await bucket.put(pageOf(12), 'landed after the claim');
      const { blobs } = serverEnvFromBindings({ MYCO_DB: db as never, BUCKET: bucket as never, SOURCE_LIMIT: { limit: async () => ({ success: true }) } as never, TOKEN_LIMIT: { limit: async () => ({ success: true }) } as never });
      const at = Date.now() + BLOB_RESERVATION_TTL_MS + 60_000;
      expect(await reconcileStoredObjects({ db: db as never, blobs }, at)).toEqual({ released: 0, ownerless: 1, vectorPages: 1 });
      expect(await journaled(db as never)).toEqual([objectOf(11), pageOf(12)]);
    } finally { await mf.dispose(); }
  }, 60_000);
});

describe('a walk over the object store', () => {
  it('releases an object nothing owns once its grace has passed, and finds a young one on a later pass', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    seeded(blobs, objectOf(2), YOUNG);
    await reconcileStoredObjects(env(db, blobs), NOW);
    expect(await journaled(db)).toEqual([objectOf(1)]);
    expect(await reconcileStoredObjects(env(db, blobs), NOW + 1)).toEqual(NOTHING);
    expect(await drainObjectReleases(env(db, blobs), NOW)).toMatchObject({ deleted: 0 });
    expect(blobs.objects.size).toBe(2);

    await drainObjectReleases(env(db, blobs), NOW + QUARANTINE);
    expect([...blobs.objects.keys()]).toEqual([objectOf(2)]);
    expect(await journaled(db)).toEqual([objectOf(2)]);
  }));

  it('never reads a name this Deployment does not write as anything to release', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    for (const name of ['backups/d__1__bk_1.jsonl', 'recovery-staging/obj/project/x', `project/${key(1)}~not-a-generation`, `project/short~${generation(1)}`, 'vector-pages/project/not-a-uuid']) seeded(blobs, name);
    await reconcileStoredObjects(env(db, blobs), NOW);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.objects.size).toBe(5);
  }));

  it('keeps an object while anything owns it: its registration, reference, reservation or unresolved write', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await register(db, 1);
    await hold(db, 1);
    await register(db, 2, YOUNG.getTime());
    await db.prepare(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at) VALUES(?,'project',?,'t',1,?)`).bind(generation(3), key(3), NOW + 60_000).run();
    await db.prepare(`INSERT INTO object_settlement_intents(physical,kind,expires_at,project_id,key,generation) VALUES(?,'upload',?,'project',?,?)`).bind(objectOf(4), NOW + 60_000, key(4), generation(4)).run();
    for (const n of [1, 2, 3, 4]) seeded(blobs, objectOf(n));
    await reconcileStoredObjects(env(db, blobs), NOW);
    await drainObjectReleases(env(db, blobs), NOW);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.objects.size).toBe(4);
  }));

  it('releases an upload whose event never arrived with its row, and keeps the storage counters exact', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await db.prepare(`UPDATE projection_catchup SET done=1 WHERE projection='storage_usage'`).run();
    await register(db, 1);
    await hold(db, 2);
    await register(db, 2);
    seeded(blobs, objectOf(1));
    seeded(blobs, objectOf(2));
    expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'ready', blobs: 2, registeredLogicalBytes: 2 });
    expect((await reconcileStoredObjects(env(db, blobs), NOW)).released).toBe(1);
    await drainObjectReleases(env(db, blobs), NOW + QUARANTINE);
    expect([...blobs.objects.keys()]).toEqual([objectOf(2)]);
    expect(await db.prepare('SELECT key FROM blobs').all()).toMatchObject({ results: [{ key: key(2) }] });
    expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'ready', blobs: 1, registeredLogicalBytes: 1 });
  }));

  it('never releases an object registered or referenced after its listing was taken', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    seeded(blobs, objectOf(2));
    await register(db, 2);
    const listed = blobs.list.bind(blobs);
    blobs.list = async (options: BlobListOptions) => {
      const page = await listed(options);
      await register(db, 1, NOW);
      await hold(db, 2);
      return page;
    };
    await reconcileStoredObjects(env(db, blobs), NOW);
    await drainObjectReleases(env(db, blobs), NOW);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.objects.size).toBe(2);
    expect((await db.prepare('SELECT key FROM blobs ORDER BY key').all<{ key: string }>()).results.map(r => r.key)).toEqual([key(1), key(2)]);
  }));

  it('releases an unnamed vector page and keeps one a page row still names', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, pageOf(1));
    seeded(blobs, pageOf(2));
    await db.prepare(`INSERT INTO embedding_vector_pages(project_id,model_key,object_key,size,created_at) VALUES('project','m',?,1,1)`).bind(pageOf(2)).run();
    await reconcileStoredObjects(env(db, blobs), NOW);
    expect(await journaled(db)).toEqual([pageOf(1)]);
  }));

  it('walks nothing while a recovery hold is open, and leaves its position where it was', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    expect(await acquireRecoveryHold(db, 'hold-token', NOW)).toBe(true);
    expect(await reconcileStoredObjects(env(db, blobs), NOW)).toEqual(NOTHING);
    expect(await journaled(db)).toEqual([]);
    expect(await walkPosition(db)).toEqual({ after_key: '', next_pass_at: 0 });
  }));

  it('a store delete that fails leaves a retryable record, and the object goes once a delete is acknowledged', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    await reconcileStoredObjects(env(db, blobs), NOW);
    const remove = blobs.delete.bind(blobs);
    blobs.delete = async () => { throw new Error('store unavailable'); };
    expect((await drainObjectReleases(env(db, blobs), NOW + QUARANTINE)).unacknowledged).toBe(1);
    expect(await journaled(db)).toEqual([objectOf(1)]);
    expect(blobs.objects.size).toBe(1);
    blobs.delete = remove;
    await drainObjectReleases(env(db, blobs), NOW + QUARANTINE + 60 * 60 * 1000);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.objects.size).toBe(0);
  }));

  it('resumes from the last object it decided, and wraps with a rest once it reaches the end', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    const total = RELEASE_PAGE + 3;
    for (let n = 1; n <= total; n += 1) seeded(blobs, objectOf(n));
    await reconcileStoredObjects(env(db, blobs), NOW);
    expect((await journaled(db)).length).toBe(RELEASE_PAGE);
    expect((await walkPosition(db))?.after_key).toBe(objectOf(RELEASE_PAGE));
    await reconcileStoredObjects(env(db, blobs), NOW + 1);
    expect((await journaled(db)).length).toBe(total);
    expect(await walkPosition(db)).toEqual({ after_key: '', next_pass_at: NOW + 1 + OBJECT_RECONCILE_PASS_MS });
  }));

  it('answers the same read cost for a page however many objects are registered', () => withDocumentStores(async (db, target) => {
    if (target !== 'D1') return;
    const blobs = memoryBlobStore();
    for (let n = 1; n <= RELEASE_PAGE; n += 1) seeded(blobs, blobObjectKey('project', key(n), generation(1)));
    await db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<?2)
      SELECT 'project',printf('%064x',n),?1,'event','e'||n,'e','h','s',printf('%064x',n),1,1,1 FROM c`).bind(generation(1), RELEASE_PAGE).run();
    let seededTo = 0;
    const reads = async (scale: number) => {
      await db.prepare(`WITH RECURSIVE c(n) AS (SELECT ? UNION ALL SELECT n+1 FROM c WHERE n<?)
        INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) SELECT 'project',printf('%064x',n),1,'text/plain','t',?,? FROM c`).bind(seededTo + 1, scale, AGED.getTime(), generation(1)).run();
      seededTo = scale;
      let total = 0;
      const measured: RelationalStore = { ...db, prepare: (sql) => db.prepare(sql), batch: async (statements) => {
        const results = await db.batch(statements);
        for (const result of results) total += Number((result.meta as { rows_read?: number }).rows_read ?? 0);
        return results;
      } };
      await db.prepare('UPDATE object_store_reconciliation SET after_key=\'\',next_pass_at=0').run();
      await reconcileStoredObjects({ db: measured, blobs }, NOW);
      return total;
    };
    expect(await reads(1_000)).toBe(await reads(5_000));
  }));
});

describe('a database owns only what landed after it claimed the store', () => {
  const passes = async (db: RelationalStore, blobs: MemoryBlobStore, count: number) => {
    for (let pass = 0; pass < count; pass += 1) {
      await restartWalk(db);
      await drainObjectReleases(env(db, blobs), NOW + (pass + 1) * 2 * QUARANTINE);
    }
  };

  it('a fresh database over a populated store releases nothing and deletes nothing, however many passes run', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    const old = new Date(await walkFloor(db) - 1);
    const names = [objectOf(1), `project/${key(2)}`, pageOf(3), `other/${key(4)}~${generation(4)}`];
    for (const name of names) seeded(blobs, name, old);
    await passes(db, blobs, 12);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.deletes).toEqual([]);
    expect([...blobs.objects.keys()].sort()).toEqual([...names].sort());
  }));

  it('a Deployment that has started taking captures still leaves the old objects alone', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    const old = new Date(await walkFloor(db) - 1);
    await register(db, 1);
    await hold(db, 1);
    seeded(blobs, objectOf(1));
    seeded(blobs, objectOf(2), old);
    await passes(db, blobs, 12);
    expect(blobs.deletes).toEqual([]);
    expect(blobs.objects.size).toBe(2);
  }));

  it('leaves an unreferenced registration from before the claim alone, row and object', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await register(db, 1);
    seeded(blobs, objectOf(1), new Date(await walkFloor(db) - 1));
    await passes(db, blobs, 6);
    expect(await db.prepare('SELECT key FROM blobs').all()).toMatchObject({ results: [{ key: key(1) }] });
    expect(blobs.objects.size).toBe(1);
  }));

  it('leaves an object alone when its Project is unknown here, even after the claim', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    const elsewhere = `vector-pages/elsewhere/${generation(1)}`;
    seeded(blobs, `elsewhere/${key(1)}~${generation(1)}`);
    seeded(blobs, elsewhere);
    await passes(db, blobs, 4);
    expect(await journaled(db)).toEqual([]);
    expect(blobs.objects.size).toBe(2);
  }));

  it('decides nothing from a listing taken before its lifecycle was reset', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    await register(db, 1);
    const listed = blobs.list.bind(blobs);
    blobs.list = async (options: BlobListOptions) => {
      const page = await listed(options);
      await resetRecoveryLedger(db);
      return page;
    };
    expect(await reconcileStoredObjects(env(db, blobs), NOW)).toEqual(NOTHING);
    expect(await journaled(db)).toEqual([]);
    expect((await db.prepare('SELECT key FROM blobs').all<{ key: string }>()).results.map(r => r.key)).toEqual([key(1)]);
  }));

  it('claims anew when its object lifecycle is reset for a restore', () => withDocumentStores(async (db) => {
    await db.prepare('UPDATE object_store_reconciliation SET armed_at=1').run();
    await resetRecoveryLedger(db);
    expect(await walkFloor(db)).toBeGreaterThan(1_000_000_000_000);
  }));

  it('holds what it finds in quarantine before any store delete, counts it, and does not spin on it', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    seeded(blobs, objectOf(1));
    seeded(blobs, pageOf(2));
    await register(db, 3);
    seeded(blobs, objectOf(3));
    expect(await reconcileStoredObjects(env(db, blobs), NOW)).toEqual({ released: 1, ownerless: 1, vectorPages: 1 });
    const due = (await db.prepare('SELECT DISTINCT created_at AS at FROM object_releases').all<{ at: number }>()).results;
    expect(due).toEqual([{ at: NOW + QUARANTINE }]);
    const report = await drainObjectReleases(env(db, blobs), NOW + QUARANTINE - 1);
    expect(report.deleted).toBe(0);
    expect(await objectReleaseBacklogged(db, NOW + QUARANTINE - 1, report)).toBe(false);
    expect(blobs.deletes).toEqual([]);
  }));
});

describe('the drain owes its backlog', () => {
  const journalRows = async (db: RelationalStore, count: number) => {
    for (let n = 1; n <= count; n += 1) await db.prepare(`INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'upload',1)`).bind(objectOf(n)).run();
  };
  it('reports more while journal rows or decided candidates remain beyond a page, and stops when they are done', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await journalRows(db, DRAIN_PAGE + 2);
    let report = await drainObjectReleases(env(db, blobs), NOW);
    expect(await objectReleaseBacklogged(db, NOW, report)).toBe(true);
    report = await drainObjectReleases(env(db, blobs), NOW);
    expect(await objectReleaseBacklogged(db, NOW, report)).toBe(false);
  }));

  it('does not spin on a failed delete: it waits for that key and the next wake', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await journalRows(db, 3);
    blobs.delete = async () => { throw new Error('store unavailable'); };
    const report = await drainObjectReleases(env(db, blobs), NOW);
    expect(report.unacknowledged).toBeGreaterThan(0);
    expect(await objectReleaseBacklogged(db, NOW, report)).toBe(false);
  }));

  it('does not report candidates it may not decide while a hold is open', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    await register(db, 1);
    await db.batch(recordObservedCandidates(db, [{ projectId: 'project', key: key(1), generation: generation(1) }], NOW - 1));
    expect(await acquireRecoveryHold(db, 'hold-token', NOW)).toBe(true);
    const report = await drainObjectReleases(env(db, blobs), NOW);
    expect(await objectReleaseBacklogged(db, NOW, report)).toBe(false);
  }));

  it('a waiting candidate inside the upload grace never holds up the candidates behind it', () => withDocumentStores(async (db) => {
    const blobs = memoryBlobStore();
    for (let n = 1; n <= DRAIN_PAGE + 2; n += 1) {
      await register(db, n, NOW - 1_000);
      await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at,generation) VALUES('project',?,?,'*')`).bind(key(n), NOW - 500).run();
    }
    await register(db, 100);
    seeded(blobs, objectOf(100));
    await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at,generation) VALUES('project',?,?,?)`).bind(key(100), NOW - 400, generation(100)).run();
    for (let pass = 0; pass < 3; pass += 1) await drainObjectReleases(env(db, blobs), NOW);
    expect(await db.prepare('SELECT key FROM blobs WHERE key=?').bind(key(100)).first()).toBeNull();
    const waiting = await db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS due FROM blob_release_candidates WHERE generation='*'`).first<{ n: number; due: number }>();
    expect(waiting).toEqual({ n: DRAIN_PAGE + 2, due: NOW - 1_000 + BLOB_RESERVATION_TTL_MS });
  }));
});
