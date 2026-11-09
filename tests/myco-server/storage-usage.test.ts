import { describe, expect, it } from 'bun:test';
import { recordCurrent, releaseNow } from './helpers/release-now.js';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { acquireRecoveryHold, assignRestoreGeneration, drainObjectReleases, recordBlobCandidates, recordObservedCandidates, releaseAgedOrphans, releaseBlobs, releaseRecoveryHold, resetRecoveryLedger } from '@myco-server-worker/core/object-release.js';
import { admitBlobUpload } from '@myco-server-worker/db/storage/blob-admission.js';
import { freeOrphanedBlobs } from '@myco-server-worker/ingest/retention.js';
import { releaseHolders } from '@myco-server-worker/ingest/document-batch.js';
import { catchUpProjections, catchUpPhase, resetProjectionCatchup, projectionReadiness } from '@myco-server-worker/db/projections/catchup.js';
import { readDeploymentStorageUsage, STORAGE_USAGE_PAGE, STORAGE_USAGE_PHASE } from '@myco-server-worker/db/storage/usage.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { latestOutcome, runMaintenance } from '@myco-server-worker/core/store-maintenance.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';

const GENERATION = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const NOW = 2_000_000_000_000;
const PROJECTS = ['proj_a', 'proj_b', 'proj_c'];
const ALWAYS = { sql: '1=1', params: [] as unknown[] };
type Row = { project: string; key: string; size: number };

function objectStore() {
  const objects = new Set<string>();
  return { objects, blobs: { delete: async (key: string) => { objects.delete(key); } } as unknown as Parameters<typeof drainObjectReleases>[0]['blobs'] };
}

async function migrate(db: RelationalStore) {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT INTO members(id,label,created_at) VALUES('member','member',1)`),
    db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
      VALUES('credential','member','machine','hash',1,99999999,'credential',1)`),
    ...PROJECTS.map(p => db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)`).bind(p, p)),
  ]);
}

/** A blob registered the way an upload registers it, under the statement's own condition. */
const registerRow = (db: RelationalStore, row: { projectId: string; key: string; size: number; mediaType: string; tokenId: string; receivedAt: number; generation: string; authority: { sql: string; params: unknown[] } }) =>
  db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) SELECT ?,?,?,?,?,?,? WHERE ${row.authority.sql} ON CONFLICT(project_id,key) DO NOTHING`)
    .bind(row.projectId, row.key, row.size, row.mediaType, row.tokenId, row.receivedAt, row.generation, ...row.authority.params);

const register = (db: RelationalStore, row: Row, generation: string) => db.batch([registerRow(db, {
  projectId: row.project, key: row.key, size: row.size, mediaType: 'text/plain', tokenId: 'credential', receivedAt: 1, generation, authority: ALWAYS,
})]);

async function recount(db: RelationalStore) {
  const per = (await db.prepare(`SELECT project_id,COUNT(*) blobs,SUM(size) bytes FROM blobs GROUP BY project_id ORDER BY project_id`).all<{ project_id: string; blobs: number; bytes: number }>()).results;
  const counters = (await db.prepare(`SELECT project_id,blobs,registered_logical_bytes bytes FROM storage_usage WHERE project_id<>'' AND (blobs<>0 OR registered_logical_bytes<>0) ORDER BY project_id`)
    .all<{ project_id: string; blobs: number; bytes: number }>()).results;
  const total = await db.prepare(`SELECT COUNT(*) blobs,COALESCE(SUM(size),0) bytes FROM blobs`).first<{ blobs: number; bytes: number }>();
  const deployment = await db.prepare(`SELECT blobs,registered_logical_bytes bytes FROM storage_usage WHERE project_id=''`).first<{ blobs: number; bytes: number }>();
  return { per, counters, total, deployment: deployment ?? { blobs: 0, bytes: 0 } };
}
async function expectExact(db: RelationalStore, label: string) {
  const r = await recount(db);
  expect(r.counters, label).toEqual(r.per);
  expect(r.deployment, label).toEqual(r.total!);
}

const stores = ['native', 'D1'] as const;

async function withStore<T>(target: typeof stores[number], body: (db: RelationalStore) => Promise<T>): Promise<T> {
  if (target === 'native') {
    const native = new Database(':memory:');
    try { const db = sqliteRelationalStore(native); await migrate(db); return await body(db); } finally { native.close(); }
  }
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try { const db = await mf.getD1Database('DB') as unknown as RelationalStore; await migrate(db); return await body(db); } finally { await mf.dispose(); }
}

/** One seeded generator: the same sequence on both stores, so a store difference reads as a test failure. */
function rng(seed: number) {
  let s = seed;
  return (n: number) => { s = (s * 1664525 + 1013904223) >>> 0; return s % n; };
}

async function drain(db: RelationalStore, blobs: ReturnType<typeof objectStore>['blobs'], at: number) {
  for (let i = 0; i < 40; i += 1) {
    const reports = await drainObjectReleases({ db, blobs }, at);
    if (reports.deleted === 0 && reports.decided === 0 && reports.expired === 0) break;
  }
}

async function build(db: RelationalStore) {
  for (let i = 0; i < 200; i += 1) {
    const { more, failures } = await catchUpProjections(db, { budget: { calls: 500, wallMs: 60_000 } });
    expect(failures).toBeUndefined();
    if (!more) return;
  }
  throw new Error('storage usage catch-up did not finish');
}

describe('storage usage counters', () => {
  it.each(stores)('stay exact against a recount through uploads, dedupes, releases, retries, Project removal and restore on %s', async target => {
    await withStore(target, async db => {
      const store = objectStore();
      const live: Row[] = [];
      const next = rng(424242);
      let generation = 1;
      let fresh = 0;
      await expectExact(db, 'empty');
      for (let step = 0; step < 220; step += 1) {
        const roll = next(20);
        if (roll < 9) {
          const project = PROJECTS[next(3)]!;
          const key = `k${fresh += 1}`;
          const size = 1 + next(5000);
          await register(db, { project, key, size }, GENERATION(generation += 1));
          live.push({ project, key, size });
        } else if (roll < 12 && live.length > 0) {
          const dup = live[next(live.length)]!;
          await register(db, { ...dup, size: dup.size + 999 }, GENERATION(generation += 1));
        } else if (roll < 16 && live.length > 0) {
          const removed = live.splice(next(live.length), 1)[0]!;
          const outcome = await releaseNow(db, [{ projectId: removed.project, key: removed.key }], NOW);
          expect(outcome.released, `release of ${removed.key}`).toBe(1);
        } else if (roll < 17) {
          await drain(db, store.blobs, NOW + 1);
        } else if (roll < 18 && live.length > 0) {
          const project = PROJECTS[next(3)]!;
          const gone = live.filter(row => row.project === project);
          await releaseNow(db, gone.map(row => ({ projectId: row.project, key: row.key })), NOW);
          for (const row of gone) live.splice(live.indexOf(row), 1);
        } else if (roll < 19) {
          await resetProjectionCatchup(db);
          expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'building' });
          await build(db);
        } else {
          await resetRecoveryLedger(db);
          await assignRestoreGeneration(db, GENERATION(generation += 1));
          await build(db);
        }
        await expectExact(db, `step ${step} roll ${roll}`);
        expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'ready', blobs: live.length, registeredLogicalBytes: live.reduce((sum, row) => sum + row.size, 0) });
      }
    });
  }, 120_000);

  it.each(stores)('reports building until an interrupted keyset build has counted existing blobs, racing writes at every position on %s', async target => {
    await withStore(target, async db => {
      const rows = Array.from({ length: STORAGE_USAGE_PAGE + 40 }, (_, n) => ({ project: PROJECTS[n % 3]!, key: `key-${String(n).padStart(5, '0')}`, size: 3 + (n % 7) }));
      for (let at = 0; at < rows.length; at += 80) await db.batch(rows.slice(at, at + 80).map((row, i) => registerRow(db,
        { projectId: row.project, key: row.key, size: row.size, mediaType: 'text/plain', tokenId: 'credential', receivedAt: 1, generation: GENERATION(at + i + 1), authority: ALWAYS })));
      await resetProjectionCatchup(db);
      expect(await projectionReadiness(db, 'storage_usage')).toBe('building');
      expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'building' });
      await catchUpPhase(db, STORAGE_USAGE_PHASE, NOW);
      expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'building' });

      const inPageWindow = { project: 'proj_a', key: 'key-00500-a-late', size: 111 };
      const pastFrontier = { project: 'proj_zz', key: 'zzz-past-the-frontier', size: 222 };
      const behindCursor = { project: 'proj_a', key: 'aaa-behind-the-cursor', size: 333 };
      const removedAhead = rows[rows.length - 1]!;
      await db.batch([registerRow(db, { projectId: inPageWindow.project, key: inPageWindow.key, size: inPageWindow.size, mediaType: 'text/plain', tokenId: 'credential', receivedAt: 1, generation: GENERATION(9001), authority: ALWAYS })]);
      await db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_zz','zz',1)`).run();
      await register(db, pastFrontier, GENERATION(9002));
      await register(db, behindCursor, GENERATION(9003));
      await releaseNow(db, [{ projectId: removedAhead.project, key: removedAhead.key }], NOW);
      await build(db);
      expect(await projectionReadiness(db, 'storage_usage')).toBe('ready');
      await expectExact(db, 'after a racing build');
      const expected = rows.slice(0, -1).concat([inPageWindow, pastFrontier, behindCursor]);
      expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'ready', blobs: expected.length, registeredLogicalBytes: expected.reduce((sum, row) => sum + row.size, 0) });
    });
  }, 120_000);

  it('refuses a page whose build was restarted between its read and its commit, and never counts it twice', async () => {
    await withStore('native', async db => {
      await register(db, { project: 'proj_a', key: 'seed', size: 7 }, GENERATION(1));
      await resetProjectionCatchup(db);
      let batches = 0;
      const racing: RelationalStore = { ...db, batch: async statements => {
        batches += 1;
        if (batches === 2) await resetProjectionCatchup(db);
        return db.batch(statements);
      } };
      await expect(catchUpPhase(racing, STORAGE_USAGE_PHASE, NOW)).rejects.toThrow();
      await build(db);
      await expectExact(db, 'after a restarted page');
      expect(await readDeploymentStorageUsage(db)).toEqual({ state: 'ready', blobs: 1, registeredLogicalBytes: 7 });
    });
  }, 30_000);

  it('makes store maintenance record building while the build runs, never a false zero, then the counter', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) VALUES('proj_1','seed',7,'text/plain','credential',1,?)`, [GENERATION(1)]);
      await resetProjectionCatchup(e.db);
      expect((await runMaintenance(e.serverEnv, 'optimize', 'owner', Date.now())).outcome).toBe('ran');
      expect((await latestOutcome(e.serverEnv, 'optimize'))!.measurements.find(m => m.name === 'blob_bytes'))
        .toEqual({ name: 'blob_bytes', state: 'unavailable', reason: 'existing stored files are still being counted', reasonCode: 'building' });
      await build(e.db);
      expect((await runMaintenance(e.serverEnv, 'optimize', 'owner', Date.now())).outcome).toBe('ran');
      expect((await latestOutcome(e.serverEnv, 'optimize'))!.measurements.find(m => m.name === 'blob_bytes'))
        .toEqual({ name: 'blob_bytes', state: 'measured', value: 7, unit: 'bytes' });
    } finally { e.sqlite.close(); }
  }, 30_000);
});

describe('ordered release queues', () => {
  it.each(stores)('reschedules only a failing head key, and every key behind it is reached, on %s', async target => {
    await withStore(target, async db => {
      const objects = objectStore();
      const keys = Array.from({ length: 40 }, (_, n) => blobObjectKey('proj_a', `object-${String(n).padStart(3, '0')}`, GENERATION(n + 1)));
      await db.batch(keys.map((key, i) => db.prepare(`INSERT INTO object_releases(physical,kind,created_at) VALUES(?,'blob',?)`).bind(key, i)));
      for (const key of keys) objects.objects.add(key);
      const head = keys[0]!;
      const failing = {
        delete: async (key: string) => { if (key === head) throw new Error('store refused'); objects.objects.delete(key); },
      } as unknown as typeof objects.blobs;
      let now = 1_000;
      for (let pass = 0; pass < 8 && objects.objects.size > 1; pass += 1) {
        const report = await drainObjectReleases({ db, blobs: failing }, now);
        expect(report.unacknowledged).toBeLessThanOrEqual(1);
        now += 1;
      }
      expect([...objects.objects]).toEqual([head]);
      const held = await db.prepare(`SELECT retry_at,attempts,last_failure FROM object_releases WHERE physical=?`).bind(head).first<{ retry_at: number; attempts: number; last_failure: string }>();
      expect(held!.attempts).toBeGreaterThanOrEqual(1);
      expect(held!.retry_at).toBeGreaterThan(1_000);
      expect(typeof held!.last_failure).toBe('string');
      expect((await db.prepare(`SELECT COUNT(*) n FROM object_releases`).first<{ n: number }>())!.n).toBe(1);
      await drainObjectReleases({ db, blobs: objects.blobs }, held!.retry_at);
      expect(objects.objects.size).toBe(0);
      expect((await db.prepare(`SELECT COUNT(*) n FROM object_releases`).first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('consumes an older due release before newer upload entries across several drains on %s', async target => {
    await withStore(target, async db => {
      const objects = objectStore();
      await register(db, { project: 'proj_a', key: 'older', size: 3 }, GENERATION(1));
      const older = blobObjectKey('proj_a', 'older', GENERATION(1));
      await releaseNow(db, [{ projectId: 'proj_a', key: 'older' }], 500);
      const createdAt = new Map<string, number>([[older, 500]]);
      const deleted: string[] = [];
      const recording = { delete: async (key: string) => { deleted.push(key); } } as unknown as typeof objects.blobs;
      let serial = 0;
      const expireUploads = async (at: number) => {
        const ids = Array.from({ length: 16 }, () => GENERATION(1000 + (serial += 1)));
        await db.batch(ids.map(id => db.prepare(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at) VALUES(?,'proj_a',?,'credential',1,?)`).bind(id, `upload-${id}`, at)));
        await admitBlobUpload(db, GENERATION(5000 + serial), 'proj_a', `next-${serial}`, 'credential', 1, at + 60_000, at);
        for (const id of ids) createdAt.set(blobObjectKey('proj_a', `upload-${id}`, id), at);
      };
      for (let pass = 1; pass <= 4; pass += 1) {
        const at = pass * 1_000;
        await expireUploads(at);
        await drainObjectReleases({ db, blobs: recording }, at);
        if (pass === 1) expect(deleted[0]).toBe(older);
      }
      const order = deleted.map(key => createdAt.get(key));
      expect(order.every(at => at !== undefined)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a! - b!));
      expect(deleted).toHaveLength(64);
    });
  }, 120_000);

  const journalOf = async (db: RelationalStore) => (await db.prepare('SELECT physical FROM object_releases ORDER BY physical').all<{ physical: string }>()).results.map(row => row.physical);
  const generationOf = async (db: RelationalStore, key: string) => (await db.prepare('SELECT generation FROM blobs WHERE project_id=? AND key=?').bind('proj_a', key).first<{ generation: string }>())?.generation ?? null;

  it.each(stores)('an orphan sweep that read an old generation never releases the registration that replaced it on %s', async target => {
    await withStore(target, async db => {
      const store = objectStore();
      await register(db, { project: 'proj_a', key: 'orphan', size: 7 }, GENERATION(1));
      await db.prepare(`INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('proj_a','gone',?,'fixture')`).bind(NOW).run();
      let batches = 0;
      const racing: RelationalStore = { prepare: db.prepare.bind(db), batch: async statements => {
        batches += 1;
        if (batches === 2) {
          await releaseNow(db, [{ projectId: 'proj_a', key: 'orphan' }], NOW);
          await drain(db, store.blobs, NOW + 1);
          await db.batch([registerRow(db, { projectId: 'proj_a', key: 'orphan', size: 7, mediaType: 'text/plain', tokenId: 'credential', receivedAt: NOW, generation: GENERATION(2), authority: ALWAYS })]);
        }
        return db.batch(statements);
      } };
      expect(await freeOrphanedBlobs({ db: racing }, NOW + 2)).toBe(0);
      expect(batches).toBeGreaterThanOrEqual(2);
      expect(await generationOf(db, 'orphan')).toBe(GENERATION(2));
      expect(await journalOf(db)).toEqual([]);
      await expectExact(db, 'after the raced sweep');
    });
  }, 120_000);

  it.each(stores)('refuses an aged registration of another generation than the sweep read on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'replaced', size: 2 }, GENERATION(2));
      expect(await releaseAgedOrphans(db, [{ projectId: 'proj_a', key: 'replaced', generation: GENERATION(1) }], NOW, NOW - 1)).toEqual({ released: 0, deferred: 0 });
      expect(await generationOf(db, 'replaced')).toBe(GENERATION(2));
      expect(await journalOf(db)).toEqual([]);
    });
  }, 120_000);

  it.each(stores)('refuses a registration newer than the age cutoff, and keeps an aged orphan through a hold on %s', async target => {
    await withStore(target, async db => {
      await db.batch([registerRow(db, { projectId: 'proj_a', key: 'fresh', size: 2, mediaType: 'text/plain', tokenId: 'credential', receivedAt: NOW, generation: GENERATION(1), authority: ALWAYS })]);
      await register(db, { project: 'proj_a', key: 'aged', size: 2 }, GENERATION(2));
      expect(await releaseAgedOrphans(db, [{ projectId: 'proj_a', key: 'fresh', generation: GENERATION(1) }], NOW, NOW - 1)).toEqual({ released: 0, deferred: 0 });
      expect(await generationOf(db, 'fresh')).toBe(GENERATION(1));
      expect(await acquireRecoveryHold(db, 'hold-token', NOW)).toBe(true);
      expect(await releaseAgedOrphans(db, [{ projectId: 'proj_a', key: 'aged', generation: GENERATION(2) }], NOW, NOW - 1)).toEqual({ released: 0, deferred: 1 });
      expect(await releaseRecoveryHold(db, 'hold-token', NOW + 1, 'complete')).toBe(true);
      await drain(db, objectStore().blobs, NOW + 2);
      expect(await generationOf(db, 'aged')).toBeNull();
    });
  }, 120_000);

  it.each(stores)('a recorded candidate reaches only the generation it observed on %s', async target => {
    await withStore(target, async db => {
      const store = objectStore();
      await register(db, { project: 'proj_a', key: 'reused', size: 4 }, GENERATION(1));
      await db.batch(await recordCurrent(db, [{ projectId: 'proj_a', key: 'reused' }], NOW));
      await drain(db, store.blobs, NOW + 1);
      expect(await generationOf(db, 'reused')).toBeNull();
      await db.batch([registerRow(db, { projectId: 'proj_a', key: 'reused', size: 4, mediaType: 'text/plain', tokenId: 'credential', receivedAt: NOW + 2, generation: GENERATION(2), authority: ALWAYS })]);
      expect(await releaseBlobs(db, [{ projectId: 'proj_a', key: 'reused' }], NOW + 3)).toEqual({ released: 0, deferred: 0 });
      expect(await generationOf(db, 'reused')).toBe(GENERATION(2));
      await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at,generation) VALUES('proj_a','reused',?,?)`).bind(NOW + 4, GENERATION(1)).run();
      await drain(db, store.blobs, NOW + 5);
      expect(await generationOf(db, 'reused')).toBe(GENERATION(2));
      expect(await journalOf(db)).toEqual([]);
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('a candidate from before generations were observed waits out the orphan grace, then releases, on %s', async target => {
    await withStore(target, async db => {
      await db.batch([registerRow(db, { projectId: 'proj_a', key: 'fresh', size: 1, mediaType: 'text/plain', tokenId: 'credential', receivedAt: NOW - 1, generation: GENERATION(2), authority: ALWAYS })]);
      await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at) VALUES('proj_a','fresh',?)`).bind(NOW).run();
      await drain(db, objectStore().blobs, NOW + 20);
      expect(await generationOf(db, 'fresh')).toBe(GENERATION(2));
      expect(await journalOf(db)).toEqual([]);
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(1);
      await drain(db, objectStore().blobs, NOW + BLOB_RESERVATION_TTL_MS + 20);
      expect(await generationOf(db, 'fresh')).toBeNull();
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('a candidate with no observed generation leaves the queue so the one behind it is decided on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'shared', size: 1 }, GENERATION(1));
      await register(db, { project: 'proj_a', key: 'behind', size: 1 }, GENERATION(2));
      await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at,generation) VALUES('proj_a','shared',?,NULL)`).bind(NOW).run();
      await db.batch(await recordCurrent(db, [{ projectId: 'proj_a', key: 'behind' }], NOW + 1));
      await drain(db, objectStore().blobs, NOW + 2);
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
      expect(await generationOf(db, 'shared')).toBe(GENERATION(1));
      expect(await generationOf(db, 'behind')).toBeNull();
    });
  }, 120_000);

  it.each(stores)('a legacy candidate with no blob is simply cleared on %s', async target => {
    await withStore(target, async db => {
      await db.prepare(`INSERT INTO blob_release_candidates(project_id,key,created_at) VALUES('proj_a','gone',?)`).bind(NOW).run();
      await drain(db, objectStore().blobs, NOW + 20);
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  const LATER = NOW + BLOB_RESERVATION_TTL_MS + 1000;
  const proofFor = (db: RelationalStore, key: string, generation: string) => db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES('proj_a',?,?,'document','source','event','hash','s','digest',1,1,1)`).bind(key, generation).run();
  const holder = (db: RelationalStore, key: string) => db.prepare("INSERT INTO retired_objects(project_id,session_id,blob_key,source_id,retired_at) VALUES('proj_a','s',?,'source',1)").bind(key).run();

  it.each(stores)('a stale holder release cannot authorize the replacement upload of the same key on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'held', size: 1 }, GENERATION(1));
      await proofFor(db, 'held', GENERATION(1));
      await holder(db, 'held');
      const holders = [{ p: 'proj_a', s: 's', k: 'held', i: 'source' }];
      await releaseHolders(db, holders, LATER);
      expect(await generationOf(db, 'held')).toBeNull();
      await register(db, { project: 'proj_a', key: 'held', size: 1 }, GENERATION(2));
      await releaseHolders(db, holders, LATER + 2);
      await drain(db, objectStore().blobs, LATER + 3);
      expect(await generationOf(db, 'held')).toBe(GENERATION(2));
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('a holder releasing a blob inside the upload grace leaves it until the grace has passed, whoever registered it, on %s', async target => {
    await withStore(target, async db => {
      await db.batch([registerRow(db, { projectId: 'proj_a', key: 'young', size: 1, mediaType: 'text/plain', tokenId: 'credential', receivedAt: NOW, generation: GENERATION(4), authority: ALWAYS })]);
      await proofFor(db, 'young', GENERATION(4));
      await holder(db, 'young');
      await releaseHolders(db, [{ p: 'proj_a', s: 's', k: 'young', i: 'source' }], NOW);
      await drain(db, objectStore().blobs, NOW + 1);
      expect(await generationOf(db, 'young')).toBe(GENERATION(4));
      expect(await journalOf(db)).toEqual([]);
      expect((await db.prepare('SELECT COUNT(*) n FROM retired_objects').first<{ n: number }>())!.n).toBe(0);
      await drain(db, objectStore().blobs, LATER);
      expect(await generationOf(db, 'young')).toBeNull();
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('a holder whose pass never registered its key cannot release a fresh upload of the same bytes on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'same', size: 1 }, GENERATION(3));
      await holder(db, 'same');
      await releaseHolders(db, [{ p: 'proj_a', s: 's', k: 'same', i: 'source' }], NOW);
      await drain(db, objectStore().blobs, NOW + 1);
      expect(await generationOf(db, 'same')).toBe(GENERATION(3));
      expect(await journalOf(db)).toEqual([]);
    });
  }, 120_000);

  it.each(stores)('a bundle whose proof names another generation records nothing for the current one on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'archive', size: 1 }, GENERATION(2));
      await db.prepare(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
        VALUES('proj_a','archive',?,'bundle','archive','event','hash','s','digest',1,1,1)`).bind(GENERATION(1)).run();
      await db.prepare(`INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,receipt_key,expires_at) VALUES('prep','proj_a','archive',NULL,?)`).bind(NOW).run();
      const guard = { preparationId: 'prep', projectId: 'proj_a', archiveKey: 'archive', receiptKey: null, expiresAt: NOW, agedAt: null };
      await db.batch(recordBlobCandidates(db, [{ projectId: 'proj_a', key: 'archive' }], NOW, guard));
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
    });
  }, 120_000);

  it.each(stores)('a pass that read an earlier generation, or a bundle already gone, records nothing against a replacement upload on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'again', size: 1 }, GENERATION(2));
      await db.batch([...recordObservedCandidates(db, [{ projectId: 'proj_a', key: 'again', generation: GENERATION(1) }], NOW), ...recordBlobCandidates(db, [{ projectId: 'proj_a', key: 'again' }], NOW, { bundle: { projectId: 'proj_a', bundleId: 404, archiveKey: 'again' } })]);
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(0);
      await db.batch(recordObservedCandidates(db, [{ projectId: 'proj_a', key: 'again', generation: GENERATION(2) }], NOW));
      expect((await db.prepare('SELECT COUNT(*) n FROM blob_release_candidates').first<{ n: number }>())!.n).toBe(1);
    });
  }, 120_000);

  it.each(stores)('a candidate held across a restore still reaches its renamed registration on %s', async target => {
    await withStore(target, async db => {
      await register(db, { project: 'proj_a', key: 'kept', size: 1 }, GENERATION(1));
      await db.batch(await recordCurrent(db, [{ projectId: 'proj_a', key: 'kept' }], NOW));
      await assignRestoreGeneration(db, GENERATION(9));
      await drain(db, objectStore().blobs, NOW + 1);
      expect(await generationOf(db, 'kept')).toBeNull();
      expect(await journalOf(db)).toEqual([]);
    });
  }, 120_000);

  it.each(stores)('releases only an unreferenced candidate, keeps a crash between journal and delete retryable, and never loses the row a live reference holds, on %s', async target => {
    await withStore(target, async db => {
      const store = objectStore();
      await register(db, { project: 'proj_a', key: 'held', size: 5 }, GENERATION(1));
      await register(db, { project: 'proj_a', key: 'free', size: 9 }, GENERATION(2));
      const [heldKey, freeKey] = [blobObjectKey('proj_a', 'held', GENERATION(1)), blobObjectKey('proj_a', 'free', GENERATION(2))];
      store.objects.add(heldKey); store.objects.add(freeKey);
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_a','s','m','credential',1,1)`).run();
      await db.prepare(`INSERT INTO attachments(project_id,attachment_id,session_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
        VALUES('proj_a','a','s','e','held','text/plain',5,1,'credential',1)`).run();
      expect(await releaseNow(db, [{ projectId: 'proj_a', key: 'held' }, { projectId: 'proj_a', key: 'free' }], NOW)).toEqual({ released: 1, deferred: 0 });
      expect((await db.prepare(`SELECT key FROM blobs ORDER BY key`).all<{ key: string }>()).results).toEqual([{ key: 'held' }]);
      expect((await db.prepare(`SELECT physical FROM object_releases`).all<{ physical: string }>()).results).toEqual([{ physical: freeKey }]);
      expect(store.objects.has(freeKey)).toBe(true);
      await expectExact(db, 'after the decision, before the physical delete');
      await drainObjectReleases({ db, blobs: store.blobs }, NOW + 1);
      expect(store.objects.has(freeKey)).toBe(false);
      expect(store.objects.has(heldKey)).toBe(true);
      expect((await db.prepare(`SELECT COUNT(*) n FROM object_releases`).first<{ n: number }>())!.n).toBe(0);
      await expectExact(db, 'after the physical delete');
    });
  }, 120_000);
});
