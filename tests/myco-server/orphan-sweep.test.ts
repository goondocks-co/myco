import { expect, it } from 'bun:test';
import { registerBlob } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { ORPHAN_AUDIT_PAGE, ORPHAN_AUDIT_REST_MS, resetOrphanAudit } from '@myco-server-worker/db/storage/blob-orphan-audit.js';
import { freeOrphanedBlobs } from '@myco-server-worker/ingest/retention.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { OBJECT_WALK_QUARANTINE_MS } from '@myco-server-worker/db/storage/object-reconciliation.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';

const key = (n: number): string => n.toString(16).padStart(64, '0');
const NOW = BLOB_RESERVATION_TTL_MS + 2;
type Env = ReturnType<typeof sqliteEnv>;
const armFrom = (e: Env, at: number) => e.sqlite.run('UPDATE orphan_sweep_state SET armed_at=?', [at]);
const cursor = (e: Env) => e.sqlite.query('SELECT cursor_project,cursor_key,next_pass_at,revision FROM orphan_sweep_state WHERE id=1').get() as { cursor_project: string; cursor_key: string; next_pass_at: number; revision: number };
const held = (e: Env, digest: string) => e.sqlite.query(`INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,blob_key)
  VALUES('proj_1','e-'||?,'s','t','compaction.pre','cli','{}','h',1,1,?)`).run(digest, digest);
const blobExists = (e: Env, digest: string) => e.sqlite.query('SELECT 1 FROM blobs WHERE key=?').get(digest) !== null;
const orphan = (e: Env, n: number, receivedAt = 1) => { registerBlob(e.sqlite, { projectId: 'proj_1', key: key(n), size: 1, receivedAt }); return key(n); };

it('audits with no recent deletion, and releases an upload whose event never arrived', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  const lost = orphan(e, 1);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(1);
  expect(blobExists(e, lost)).toBe(false);
  e.sqlite.close();
});

it('leaves everything that landed before this database armed the audit, however unreferenced', async () => {
  const e = sqliteEnv();
  armFrom(e, NOW - 1);
  const old = orphan(e, 1, 1);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
  expect(blobExists(e, old)).toBe(true);
  e.sqlite.close();
});

it('arms its floor on its first run in a database that has never been audited', async () => {
  const e = sqliteEnv();
  armFrom(e, 0);
  const held_ = orphan(e, 1);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
  expect(blobExists(e, held_)).toBe(true);
  expect((e.sqlite.query('SELECT armed_at FROM orphan_sweep_state WHERE id=1').get() as { armed_at: number }).armed_at).toBe(NOW);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW + 1)).toBe(0);
  expect(blobExists(e, held_)).toBe(true);
  e.sqlite.close();
});

it('a restored database audits only what it registers after the restore', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  await resetOrphanAudit(e.db, NOW);
  const restored = orphan(e, 1, 1);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
  expect(blobExists(e, restored)).toBe(true);
  e.sqlite.close();
});

it('walks every page past referenced registrations, and rests after the pass', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  const total = ORPHAN_AUDIT_PAGE * 3;
  for (let n = 1; n <= total; n += 1) held(e, orphan(e, n));
  const tail = orphan(e, total + 1);
  for (let pass = 1; pass <= 3; pass += 1) {
    expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
    expect(cursor(e)).toMatchObject({ cursor_project: 'proj_1', cursor_key: key(pass * ORPHAN_AUDIT_PAGE) });
  }
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(1);
  expect(blobExists(e, tail)).toBe(false);
  expect(cursor(e)).toMatchObject({ cursor_project: '', cursor_key: '', next_pass_at: NOW + ORPHAN_AUDIT_REST_MS });
  e.sqlite.close();
});

it('rests between passes and finds a late orphan on the next one, reading one row while it rests', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  held(e, orphan(e, 1));
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
  const late = orphan(e, 2);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW + 1)).toBe(0);
  expect(blobExists(e, late)).toBe(true);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW + ORPHAN_AUDIT_REST_MS)).toBe(1);
  expect(blobExists(e, late)).toBe(false);
  e.sqlite.close();
});

it('keeps a recent upload available for its event until the reservation window passes', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  const recent = orphan(e, 9, NOW);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(0);
  expect(blobExists(e, recent)).toBe(true);
  expect(await freeOrphanedBlobs(e.serverEnv, NOW + ORPHAN_AUDIT_REST_MS + BLOB_RESERVATION_TTL_MS)).toBe(1);
  e.sqlite.close();
});

it('delays the store delete of what it found by the quarantine, so a rollback has a way back', async () => {
  const e = sqliteEnv();
  armFrom(e, -1);
  const lost = orphan(e, 3);
  const object = e.sqlite.query("SELECT project_id||'/'||key||'~'||generation AS physical FROM blobs WHERE key=?").get(lost) as { physical: string };
  e.bucket.seed(object.physical, { size: 1, bytes: new Uint8Array([1]) });
  expect(await freeOrphanedBlobs(e.serverEnv, NOW)).toBe(1);
  await drainObjectReleases(e.serverEnv, NOW + 1);
  expect(e.bucket.objects.has(object.physical)).toBe(true);
  await drainObjectReleases(e.serverEnv, NOW + OBJECT_WALK_QUARANTINE_MS);
  expect(e.bucket.objects.has(object.physical)).toBe(false);
  e.sqlite.close();
});
