/**
 * Backup retention as stored rows, refusals and the object store see it: the keep rule, what it never releases, what a
 * pass reports when it cannot finish, the paged list with its verification state, and the upgrade's duplicate audit.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { backupArtifact, createBackup, previewRestore, setBackupPinned, verifyBackup } from '@myco-server-worker/core/backup.js';
import { acceptRestore, advanceRestore, restoreJobProgress, stopRestore } from '@myco-server-worker/core/restore-job.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { continueBackupRetention, pruneBackups, releaseRetentionPage, retentionDecision } from '@myco-server-worker/core/backup-retention.js';
import { drainObjectReleases, objectReleaseBacklogged } from '@myco-server-worker/core/object-release.js';
import { acquireRecoveryHold, releaseRecoveryHold } from '@myco-server-worker/db/recovery/holds.js';
import { listBackupPage } from '@myco-server-worker/db/storage/backup-list.js';
import { backupPruneStatus } from '@myco-server-worker/db/meta/backup-prune.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_S8B } from '@myco-server-worker/db/schema-vNEXT-s8b.js';
import { BACKUP_RETENTION_CHANGED, RETENTION_PAGE } from '@myco-server-worker/db/storage/backup-retention.js';
import { refused } from '@myco-server-worker/db/index.js';
import { journaled, sqliteEnv } from './helpers/fixtures.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { sqliteD1 } from './helpers/d1.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const DAY = 86_400_000;
const NOW = 1000 * 7 * DAY + 5 * DAY + DAY / 2;
type Env = ReturnType<typeof sqliteEnv>;

const retention = (e: Env, daily: number, weekly: number) => {
  for (const [leaf, value] of [['backup.retention.keep_daily', daily], ['backup.retention.keep_weekly', weekly]] as const) {
    e.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(?,?,1,'m')
      ON CONFLICT(leaf) DO UPDATE SET value=excluded.value`, [leaf, JSON.stringify(value)]);
  }
};
const insert = (e: Env, id: string, ageDays: number, opts: { pinned?: number; sha256?: string; verified?: boolean } = {}) => e.sqlite.run(
  `INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned,sha256,verification_state,verification_checked_at)
   VALUES(?,?,?,1,'{}',1,'test',?,?,?,?)`, [id, `backups/${id}.jsonl`, NOW - ageDays * DAY, opts.pinned ?? 0, opts.sha256 ?? null, opts.verified === true ? 'verified' : null, opts.verified === true ? NOW : null]);
const ids = (e: Env) => (e.sqlite.query('SELECT id FROM backups ORDER BY id').all() as { id: string }[]).map(row => row.id);
const heads = (e: Env) => e.sqlite.query('SELECT week,id FROM backup_week_heads ORDER BY week DESC').all() as { week: number; id: string }[];

describe('the keep rule', () => {
  it('keeps the newest N unpinned, the head of each of W occupied weeks, and pinned rows without counting them', async () => {
    const e = sqliteEnv();
    retention(e, 2, 3);
    for (const [id, age, pinned] of [['a', 0], ['b', 1], ['c', 2], ['p', 3, 1], ['d', 9], ['e', 16], ['f', 30], ['g', 31]] as const) insert(e, id, age, { pinned: pinned ?? 0 });
    expect(await pruneBackups(e.db, NOW)).toEqual({ state: 'pruned', pruned: 3, deferred: 0 });
    expect(ids(e)).toEqual(['a', 'b', 'd', 'e', 'p']);
    expect(journaled(e.sqlite).sort()).toEqual(['backups/c.jsonl', 'backups/f.jsonl', 'backups/g.jsonl']);
    e.sqlite.close();
  });

  it('never releases the newest verified backup, even past the keep window', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'newest', 0);
    insert(e, 'middle', 1);
    insert(e, 'verified', 2, { verified: true });
    insert(e, 'older', 3);
    await pruneBackups(e.db, NOW);
    expect(ids(e)).toEqual(['newest', 'verified']);
    e.sqlite.close();
  });

  it('evaluates the rule against the rows in the commit that releases, so a stale page cannot release a kept backup', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'newest', 0);
    insert(e, 'old', 1);
    const decision = await retentionDecision(e.db);
    if (!decision.ready) throw new Error('ready');
    const outcome = await releaseRetentionPage(e.db, decision, NOW, ['newest']);
    expect(outcome).toEqual({ released: 0, deferred: 0 });
    expect(ids(e)).toEqual(['newest', 'old']);
    e.sqlite.close();
  });

  it('stops the whole batch when a publish, pin or verification moved the keep-set generation', async () => {
    for (const race of ['publish', 'pin', 'verify'] as const) {
      const e = sqliteEnv();
      retention(e, 1, 0);
      insert(e, 'old', 2);
      insert(e, 'fresh', 1);
      const decision = await retentionDecision(e.db);
      if (!decision.ready) throw new Error('ready');
      if (race === 'publish') insert(e, 'newer', 0);
      else if (race === 'pin') await setBackupPinned(e.db, 'fresh', true);
      else e.sqlite.run("UPDATE backups SET verification_state='verified' WHERE id='fresh'");
      let error: unknown;
      try { await releaseRetentionPage(e.db, decision, NOW); } catch (caught) { error = caught; }
      expect({ race, refused: refused(error, BACKUP_RETENTION_CHANGED) }).toEqual({ race, refused: true });
      expect(ids(e).includes('old')).toBe(true);
      expect(e.sqlite.query('SELECT COUNT(*) AS n FROM object_releases').get()).toEqual({ n: 0 });
      e.sqlite.close();
    }
  });
});

describe('week heads', () => {
  it('follow publish, pin and delete, and a build reaches the same heads as the triggers', async () => {
    const e = sqliteEnv();
    insert(e, 'one', 0);
    insert(e, 'two', 1);
    insert(e, 'prior', 7);
    expect(heads(e).map(head => head.id)).toEqual(['one', 'prior']);
    await setBackupPinned(e.db, 'one', true);
    expect(heads(e).map(head => head.id)).toEqual(['two', 'prior']);
    e.sqlite.run("DELETE FROM backups WHERE id='two'");
    expect(heads(e).map(head => head.id)).toEqual(['prior']);
    await setBackupPinned(e.db, 'prior', true);
    expect(heads(e)).toEqual([]);
    await setBackupPinned(e.db, 'prior', false);
    insert(e, 'late', 8);
    const fromTriggers = heads(e);
    e.sqlite.run("DELETE FROM backup_week_heads");
    e.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='backup_week_heads'");
    while ((await catchUpProjections(e.db)).more) { /* the build runs to its end */ }
    expect(heads(e)).toEqual(fromTriggers);
    e.sqlite.close();
  });

  it('reports retention as waiting while the heads are building, and releases nothing', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    insert(e, 'victim', 1);
    e.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='backup_week_heads'");
    e.sqlite.run('DELETE FROM backup_week_heads');
    expect(await pruneBackups(e.db, NOW)).toEqual({ state: 'deferred', reason: 'building' });
    expect(ids(e)).toEqual(['kept', 'victim']);
    while ((await catchUpProjections(e.db)).more) { /* the build runs to its end */ }
    expect(await pruneBackups(e.db, NOW)).toEqual({ state: 'pruned', pruned: 1, deferred: 0 });
    e.sqlite.close();
  });
});

describe('a pass that cannot finish', () => {
  it('says how many a recovery hold kept and releases them when the hold ends', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    insert(e, 'held', 1);
    await acquireRecoveryHold(e.db, 'hold-1', NOW);
    expect(await pruneBackups(e.db, NOW)).toEqual({ state: 'pruned', pruned: 0, deferred: 1 });
    expect(ids(e)).toEqual(['held', 'kept']);
    await releaseRecoveryHold(e.db, 'hold-1', NOW + 1, 'closed');
    await drainObjectReleases(e.serverEnv, NOW + 2);
    expect(ids(e)).toEqual(['kept']);
    e.sqlite.close();
  });

  it('leaves the rest of a large backlog to later drains, and a drain finishes it', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    const victims = 70;
    for (let i = 1; i <= victims; i += 1) insert(e, `v${i}`, 1 + i / 1000);
    const outcome = await pruneBackups(e.db, NOW);
    expect(outcome).toEqual({ state: 'pruned', pruned: 4 * RETENTION_PAGE, deferred: 0, remaining: true });
    expect(ids(e).length).toBe(1 + victims - 4 * RETENTION_PAGE);
    let report = await drainObjectReleases(e.serverEnv, NOW + 1);
    expect(ids(e).length).toBe(1);
    for (let pass = 0; pass < 8 && await objectReleaseBacklogged(e.db, NOW + 1, report); pass += 1) report = await drainObjectReleases(e.serverEnv, NOW + 1);
    expect(await objectReleaseBacklogged(e.db, NOW + 1, report)).toBe(false);
    expect([...e.bucket.deletes].sort()).toEqual(Array.from({ length: victims }, (_, i) => `backups/v${i + 1}.jsonl`).sort());
    e.sqlite.close();
  });
});

describe('the backup list', () => {
  it('pages newest first and each row says when it was last checked and what the check found', async () => {
    const e = sqliteEnv();
    for (let i = 0; i < 5; i += 1) insert(e, `b${i}`, i, { verified: i % 2 === 0 });
    const first = await listBackupPage(e.db, { limit: 2 });
    expect(first.backups.map(row => row.id)).toEqual(['b0', 'b1']);
    expect(first.backups[0]!.verification).toEqual({ state: 'verified', checkedAt: NOW, detail: null });
    expect(first.backups[1]!.verification).toEqual({ state: 'unverified', checkedAt: null, detail: null });
    const second = await listBackupPage(e.db, { limit: 2, cursor: first.cursor! });
    expect(second.backups.map(row => row.id)).toEqual(['b2', 'b3']);
    const last = await listBackupPage(e.db, { limit: 2, cursor: second.cursor! });
    expect(last.backups.map(row => row.id)).toEqual(['b4']);
    expect(last.cursor).toBeNull();
    e.sqlite.close();
  });

  it('records a passing check and each kind of failure', async () => {
    const e = sqliteEnv();
    const backup = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
    expect(await verifyBackup(e.db, e.bucket, backup.id, NOW + 1)).toEqual({ state: 'verified', checkedAt: NOW + 1, detail: null });
    const stored = e.bucket.objects.get(backup.key)!;
    e.bucket.objects.set(backup.key, { ...stored, bytes: stored.bytes.slice(0, -1), size: stored.size - 1 });
    expect(await verifyBackup(e.db, e.bucket, backup.id, NOW + 2)).toEqual({ state: 'failed', checkedAt: NOW + 2, detail: 'size' });
    e.bucket.objects.set(backup.key, { ...stored, bytes: stored.bytes.map((byte, at) => at === 0 ? byte ^ 1 : byte) as typeof stored.bytes });
    expect(await verifyBackup(e.db, e.bucket, backup.id, NOW + 3)).toEqual({ state: 'failed', checkedAt: NOW + 3, detail: 'sha256' });
    e.bucket.objects.delete(backup.key);
    expect(await verifyBackup(e.db, e.bucket, backup.id, NOW + 4)).toEqual({ state: 'failed', checkedAt: NOW + 4, detail: 'absent' });
    expect(await verifyBackup(e.db, e.bucket, 'bk_unknown', NOW + 4)).toBeNull();
    e.sqlite.close();
  });
});

it('reads the same rows for a list page and a retention page at two scales', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const d1 = await mf.getD1Database('DB');
    await d1.batch(['backup.retention.keep_daily', 'backup.retention.keep_weekly'].map(leaf =>
      d1.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES(?,'1',1,'m')`).bind(leaf)));
    await d1.prepare(`INSERT INTO schema_meta(key,value) VALUES('backup_prune_outcome','{}') ON CONFLICT DO NOTHING`).run();
    const measured: { list: number; retention: number }[] = [];
    let seq = 0;
    for (const size of [100, 1000]) {
      while (seq < size) {
        const page = Array.from({ length: Math.min(100, size - seq) }, (_, at) => seq + at);
        await d1.batch(page.map(i => d1.prepare(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned)
          VALUES(?,?,?,1,'{}',1,'t',0)`).bind(`b${String(i).padStart(5, '0')}`, `backups/${i}.jsonl`, 1000 * 7 * DAY + i * 60_000)));
        seq += page.length;
      }
      const meter = measuredStore(d1 as never);
      await listBackupPage(meter.db);
      const list = meter.reads();
      meter.reset();
      expect(await pruneBackups(meter.db, 2000 * DAY, 1)).toMatchObject({ state: 'pruned', pruned: RETENTION_PAGE });
      measured.push({ list, retention: meter.reads() });
    }
    expect(measured[1]).toEqual(measured[0]!);
  } finally { await mf.dispose(); }
}, 120_000);

describe('a backup a read found bad', () => {
  const twoVerifiedAndNewest = async (e: Env) => {
    retention(e, 1, 0);
    const older = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - 2 * DAY });
    const tampered = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - DAY });
    insert(e, 'newest', 0);
    return { older, tampered };
  };
  const bytesChanged = (e: Env, key: string) => {
    const stored = e.bucket.objects.get(key)!;
    e.bucket.objects.set(key, { ...stored, bytes: stored.bytes.map((byte, at) => at === 0 ? byte ^ 1 : byte) as typeof stored.bytes });
  };

  it('records a changed artifact as failed on the row, and the newest-verified slot moves to the next good backup', async () => {
    const e = sqliteEnv();
    const { older, tampered } = await twoVerifiedAndNewest(e);
    bytesChanged(e, tampered.key);
    await expect(previewRestore(e.db, e.bucket, tampered.id)).rejects.toThrow('does not match the SHA-256 digest');
    expect((await listBackupPage(e.db)).backups.find(row => row.id === tampered.id)!.verification).toMatchObject({ state: 'failed', detail: 'sha256' });
    await pruneBackups(e.db, NOW);
    expect(ids(e).sort()).toEqual(['newest', older.id].sort());
    e.sqlite.close();
  });

  it('records a missing artifact as failed when a download finds it gone', async () => {
    const e = sqliteEnv();
    const backup = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
    e.bucket.objects.delete(backup.key);
    expect(await backupArtifact(e.db, e.bucket, backup.id)).toBeNull();
    expect((await listBackupPage(e.db)).backups[0]!.verification).toMatchObject({ state: 'failed', detail: 'absent' });
    e.sqlite.close();
  });

  it('records only the check time for a row with no digest, which never takes the newest-verified slot', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'newest', 0);
    insert(e, 'no-digest', 1);
    insert(e, 'digest-checked', 2, { verified: true });
    e.bucket.objects.set('backups/no-digest.jsonl', { size: 1, bytes: new Uint8Array(1) });
    expect(await verifyBackup(e.db, e.bucket, 'no-digest', NOW)).toEqual({ state: 'unverified', checkedAt: NOW, detail: null });
    expect(e.sqlite.query("SELECT verification_state,verification_checked_at FROM backups WHERE id='no-digest'").get())
      .toEqual({ verification_state: null, verification_checked_at: NOW });
    await pruneBackups(e.db, NOW);
    expect(ids(e)).toEqual(['digest-checked', 'newest']);
    e.sqlite.close();
  });
});

describe('what Health says after a pass', () => {
  it('clears a hold-deferred status once the drain removes the backup the hold kept', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    insert(e, 'held', 1);
    await acquireRecoveryHold(e.db, 'hold-1', NOW);
    await pruneBackups(e.db, NOW);
    expect((await backupPruneStatus(e.db))!.outcome).toEqual({ state: 'pruned', pruned: 0, deferred: 1 });
    await releaseRecoveryHold(e.db, 'hold-1', NOW + 1, 'closed');
    await drainObjectReleases(e.serverEnv, NOW + 2);
    expect(ids(e)).toEqual(['kept']);
    expect((await backupPruneStatus(e.db))!.outcome).toEqual({ state: 'pruned', pruned: 1, deferred: 0 });
    e.sqlite.close();
  });

  it('reruns a pass deferred for building heads and rewrites the status', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    insert(e, 'victim', 1);
    e.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='backup_week_heads'");
    e.sqlite.run('DELETE FROM backup_week_heads');
    await pruneBackups(e.db, NOW);
    expect((await backupPruneStatus(e.db))!.outcome).toEqual({ state: 'deferred', reason: 'building' });
    while ((await catchUpProjections(e.db)).more) { /* the build runs to its end */ }
    await drainObjectReleases(e.serverEnv, NOW + 1);
    expect(ids(e)).toEqual(['kept']);
    expect((await backupPruneStatus(e.db))!.outcome).toEqual({ state: 'pruned', pruned: 1, deferred: 0 });
    e.sqlite.close();
  });

  it('keeps a failure beside the outcome until a pass finishes the backlog', async () => {
    const e = sqliteEnv();
    retention(e, 1, 0);
    insert(e, 'kept', 0);
    for (let i = 1; i <= 90; i += 1) insert(e, `v${i}`, 1 + i / 1000);
    await pruneBackups(e.db, NOW);
    let unavailable = true;
    const fault: RelationalStore = { ...e.db, batch: async statements => {
      if (unavailable) { unavailable = false; throw new Error('store unavailable'); }
      return e.db.batch(statements);
    } };
    expect(await pruneBackups(fault, NOW + 1, 1)).toMatchObject({ state: 'failed' });
    expect(await pruneBackups(e.db, NOW + 2, 1)).toMatchObject({ state: 'pruned', remaining: true });
    expect(await backupPruneStatus(e.db)).toMatchObject({ outcome: { state: 'pruned', remaining: true }, lastFailure: { at: NOW + 1 } });
    await pruneBackups(e.db, NOW + 3);
    expect(await pruneBackups(e.db, NOW + 4)).toEqual({ state: 'pruned', pruned: 0, deferred: 0 });
    expect(await backupPruneStatus(e.db)).not.toHaveProperty('lastFailure');
    e.sqlite.close();
  });
});

it('holds a backup only while a restore of it runs, and releases it once that restore completes', async () => {
  const e = sqliteEnv();
  retention(e, 1, 0);
  e.sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_bk','proj_bk',1)");
  e.sqlite.run("INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_bk','sess_1','m1','mt_seed',1,1)");
  await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', NOW);
  const first = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - 2 * DAY });
  const second = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - DAY });
  await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
  const accepted = (await acceptRestore(e.serverEnv, second.id, { allowForeignLineage: false, memberId: 'mem_machine_1', now: NOW }))!;
  while ((await catchUpProjections(e.db)).more) { /* the week heads are current before retention decides */ }
  await pruneBackups(e.db, NOW);
  expect(ids(e).includes(first.id)).toBe(false);
  expect(ids(e).includes(second.id)).toBe(true);

  while ((await advanceRestore(e.serverEnv, NOW)).more) { /* the tick walks the restore to its end */ }
  expect((await restoreJobProgress(e.serverEnv, accepted.id))?.state).toBe('complete');
  while ((await catchUpProjections(e.db)).more) { /* a restore rebuilds the heads before retention decides */ }
  await pruneBackups(e.db, NOW);
  expect(ids(e).includes(second.id)).toBe(false);
  e.sqlite.close();
});

it('releases a backup once the restore reading it ends failed', async () => {
  const e = sqliteEnv();
  retention(e, 1, 0);
  e.sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_bk','proj_bk',1)");
  await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', NOW);
  const older = await createBackup(e.db, e.bucket, { producer: 'test', now: NOW - DAY });
  await createBackup(e.db, e.bucket, { producer: 'test', now: NOW });
  const accepted = (await acceptRestore(e.serverEnv, older.id, { allowForeignLineage: false, memberId: 'mem_machine_1', now: NOW }))!;
  while ((await catchUpProjections(e.db)).more) { /* the week heads are current before retention decides */ }
  await pruneBackups(e.db, NOW);
  expect(ids(e).includes(older.id)).toBe(true);
  expect(await stopRestore(e.serverEnv, accepted.id, NOW)).toMatchObject({ stopped: { state: 'failed', failure: { code: 'stopped' } } });
  await pruneBackups(e.db, NOW);
  expect(ids(e).includes(older.id)).toBe(false);
  e.sqlite.close();
});

describe('a duplicate backup key at upgrade', () => {
  const SECTION = 'BREAK-GLASS.md section Duplicate backup key';
  const refusesAndRepairs = async (db: RelationalStore, version: () => Promise<string | null>, sql: (statement: string) => Promise<void>) => {
    await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version < NEXT_S8B));
    const seedRow = (id: string) => sql(`INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned) VALUES('${id}','backups/shared.jsonl',1,1,'{}',1,'t',0)`);
    await seedRow('a');
    await seedRow('b');
    let refusal: unknown;
    try { await applySchemaSteps(db, SCHEMA_STEPS); } catch (error) { refusal = error; }
    expect(String(refusal)).toContain('backups/shared.jsonl');
    expect(String(refusal)).toContain(SECTION);
    expect(await version()).toBe(String(NEXT_S8B - 1));
    await sql("DELETE FROM backups WHERE id='b'");
    await applySchemaSteps(db, SCHEMA_STEPS);
    expect(await version()).toBe(String(SCHEMA_STEPS.at(-1)!.version));
  };

  it('stops before anything changes on native SQLite, names the key and the repair, and a rerun applies the whole change', async () => {
    const sqlite = new Database(':memory:');
    try {
      await refusesAndRepairs(sqliteD1(sqlite),
        async () => (sqlite.query("SELECT value FROM schema_meta WHERE key='version'").get() as { value: string }).value,
        async statement => { sqlite.run(statement); });
      expect(() => sqlite.run("INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned) VALUES('c','backups/shared.jsonl',2,1,'{}',1,'t',0)")).toThrow();
    } finally { sqlite.close(); }
  });

  it('says the same through D1', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
    try {
      const d1 = await mf.getD1Database('DB');
      await refusesAndRepairs(d1 as unknown as RelationalStore,
        async () => (await d1.prepare("SELECT value FROM schema_meta WHERE key='version'").first<{ value: string }>())!.value,
        async statement => { await d1.prepare(statement).run(); });
    } finally { await mf.dispose(); }
  }, 60_000);
});
