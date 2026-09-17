import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA } from '@myco-server-worker/constants.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { blobObjectKey, blobObjectKeySql, registeredObjectKeySql, snapshotBlobObject } from '@myco-server-worker/core/blob-objects.js';
import {
  acquireRecoveryHold, assignRestoreGeneration, drainObjectReleases, releaseBlobs, releaseRecoveryHold, resetRecoveryLedger,
} from '@myco-server-worker/core/object-release.js';
import { createBackup, pruneBackups } from '@myco-server-worker/core/backup.js';
import { backupRetentionPolicy } from '@myco-server-worker/core/backup-retention.js';
import { freeOrphanedBlobs, TRANSCRIPT_RETENTION_BLOBS_PER_PASS } from '@myco-server-worker/ingest/retention.js';
import { blobPost, count, journaled, memberHeaders, registeredObject, sqliteEnv } from './helpers/fixtures.js';
import { legacyBlob, registerBlob } from './helpers/d1.js';

/**
 * The object lifecycle under a store whose operations land late.
 *
 * A delete issued to the store may have its answer lost — the instance that issued it reset — and still take effect
 * afterwards. Each schedule below delivers every such operation at the worst moment it can, then asserts the two
 * properties the lifecycle holds: no registered row names absent bytes, and no capture is refused forever.
 */

type Env = ReturnType<typeof sqliteEnv>;
const P = 'proj_1';
const bytes = utf8('lifecycle bytes');
const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

/** Deletes the drain issues whose answers are lost: each throws to its caller, and lands only when `land` runs. */
function losingDeletes(e: Env) {
  const pending: string[] = [];
  const real = e.bucket.delete.bind(e.bucket);
  let losing = false;
  e.bucket.delete = async (key) => {
    if (!losing) return real(key);
    pending.push(key);
    throw new Error('the answer to this delete was lost');
  };
  return {
    lose: (on: boolean) => { losing = on; },
    land: async () => { for (const key of pending.splice(0)) await real(key); },
  };
}

async function member(e: Env, machine = 'machine_1') {
  return issueMemberToken(e.db, { memberId: `mem_${machine}`, machineId: machine }, Date.now());
}

async function capture(e: Env, token: string, body = bytes): Promise<Record<string, unknown>> {
  return json(await worker.fetch(blobPost(token, await sha256HexOf(body), body), e.env));
}

/** Runs the drain until the journal is empty or `passes` run out. */
async function drain(e: Env, passes = 8) {
  for (let pass = 0; pass < passes && count(e.sqlite, 'object_releases') > 0; pass += 1) await drainObjectReleases(e.serverEnv, Date.now());
}

/** Every registered row whose stored object is absent: data loss, which must be empty. */
function lost(e: Env): string[] {
  const rows = e.sqlite.query(`SELECT ${blobObjectKeySql('project_id', 'key', 'generation')} AS object_key FROM blobs`).all() as { object_key: string }[];
  return rows.map((row) => row.object_key).filter((key) => !e.bucket.objects.has(key));
}

/** Stored objects no row, journal row or live authority names. */
function unnamed(e: Env): string[] {
  const named = new Set<string>([
    ...(e.sqlite.query(`SELECT ${blobObjectKeySql('project_id', 'key', 'generation')} AS k FROM blobs`).all() as { k: string }[]).map((r) => r.k),
    ...journaled(e.sqlite),
    ...(e.sqlite.query(`SELECT ${blobObjectKeySql('project_id', 'key', 'reservation_id')} AS k FROM blob_reservations`).all() as { k: string }[]).map((r) => r.k),
  ]);
  return [...e.bucket.objects.keys()].filter((key) => !named.has(key) && !key.startsWith('backups/'));
}

const release = async (e: Env, key: string) => releaseBlobs(e.db, [{ projectId: P, key }], Date.now());

describe('the object lifecycle under late store operations', () => {
  it('S1: a delete answered too late for its drainer, landing after the same content is registered again, removes nothing registered', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    expect((await capture(e, t.token)).stored).toBe(true);
    const first = registeredObject(e.sqlite, P, key)!;
    expect((await release(e, key)).released).toBe(1);
    const deletes = losingDeletes(e);
    deletes.lose(true);
    await drainObjectReleases(e.serverEnv, Date.now());
    deletes.lose(false);
    await drain(e);
    expect(journaled(e.sqlite)).toEqual([]);
    expect((await capture(e, t.token)).stored).toBe(true);
    await deletes.land();
    const second = registeredObject(e.sqlite, P, key)!;
    expect(second).not.toBe(first);
    expect(lost(e)).toEqual([]);
    expect(e.bucket.objects.get(second)?.bytes).toEqual(bytes);
  });

  it('S4: a store write whose outcome was unknown, landing after its clean-up was acknowledged, leaves bytes nothing names and never blocks a later capture', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    const real = e.bucket.put.bind(e.bucket);
    const late: Array<() => Promise<unknown>> = [];
    e.bucket.put = async (objectKey, value, options) => {
      const body = new Uint8Array(await new Response(value).arrayBuffer());
      late.push(() => real(objectKey, new Response(body).body, options));
      throw new Error('the store write outcome is unknown');
    };
    const first = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(first.status).toBe(503);
    expect(journaled(e.sqlite)).toHaveLength(1);
    await drain(e);
    for (const write of late.splice(0)) await write();
    e.bucket.put = real;
    expect((await capture(e, t.token)).stored).toBe(true);
    expect(lost(e)).toEqual([]);
    // The one open requirement this lifecycle states: a write landing after its acknowledged clean-up is storage
    // nothing names, reclaimable only by a store walk this slice does not add.
    expect(unnamed(e)).toHaveLength(1);
    expect(unnamed(e)[0]).not.toBe(registeredObject(e.sqlite, P, key));
  });

  it('S5b: an authority swept while its write is in flight, whose write lands after the sweep\'s delete, leaves registered bytes whole on retry', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    const real = e.bucket.put.bind(e.bucket);
    const late: Array<() => Promise<unknown>> = [];
    e.bucket.put = async (objectKey, value, options) => {
      const body = new Uint8Array(await new Response(value).arrayBuffer());
      late.push(() => real(objectKey, new Response(body).body, options));
      // The request's instance goes away with its write on the wire: the authority is left to expire.
      e.sqlite.run('UPDATE blob_reservations SET expires_at = 0');
      await drainObjectReleases(e.serverEnv, Date.now());
      throw new Error('the instance went away');
    };
    await worker.fetch(blobPost(t.token, key, bytes), e.env);
    await drain(e);
    for (const write of late.splice(0)) await write();
    e.bucket.put = real;
    expect((await capture(e, t.token)).stored).toBe(true);
    expect(lost(e)).toEqual([]);
    expect(count(e.sqlite, 'blob_reservations')).toBe(0);
  });

  it('S6: the same content is captured, released and captured again across days of lost delete answers, and is never refused', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    const deletes = losingDeletes(e);
    for (let day = 0; day < 3; day += 1) {
      expect(await capture(e, t.token)).toMatchObject({ stored: true, duplicate: false });
      await release(e, key);
      deletes.lose(true);
      await drainObjectReleases(e.serverEnv, Date.now());
      deletes.lose(false);
      expect(await capture(e, t.token)).toMatchObject({ stored: true });
      await drain(e);
      await deletes.land();
      expect(lost(e)).toEqual([]);
      await release(e, key);
      await drain(e);
    }
    expect(await capture(e, t.token)).toMatchObject({ stored: true, duplicate: false });
    expect(lost(e)).toEqual([]);
    expect(e.sqlite.query('SELECT bytes_written FROM member_credentials WHERE id = ?').get(t.tokenId)).toBeDefined();
  });

  it('S7: drains that overlap — a replaced instance still issuing a page the new one already cleared — remove nothing registered', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    await capture(e, t.token);
    await release(e, key);
    const real = e.bucket.delete.bind(e.bucket);
    const stalled: Array<() => Promise<void>> = [];
    let first = true;
    e.bucket.delete = async (objectKey) => {
      if (first) {
        first = false;
        // The first drainer's delete stalls on the wire; its drainer is replaced and never hears back.
        stalled.push(() => real(objectKey));
        throw new Error('replaced');
      }
      return real(objectKey);
    };
    await Promise.all([drainObjectReleases(e.serverEnv, Date.now()), drainObjectReleases(e.serverEnv, Date.now())]);
    await drain(e);
    expect(journaled(e.sqlite)).toEqual([]);
    expect((await capture(e, t.token)).stored).toBe(true);
    for (const land of stalled) await land();
    expect(lost(e)).toEqual([]);
  });

  it('S8: two uploads of the same content in flight at once register one row, and the other\'s bytes are journaled and deleted', async () => {
    const e = sqliteEnv();
    const [a, b] = [await member(e), await member(e, 'machine_2')];
    const answers = await Promise.all([capture(e, a.token), capture(e, b.token)]);
    expect(answers.map((answer) => answer.stored)).toEqual([true, true]);
    expect(answers.filter((answer) => answer.duplicate === true)).toHaveLength(1);
    await drain(e);
    expect(lost(e)).toEqual([]);
    expect(unnamed(e)).toEqual([]);
    expect([...e.bucket.objects.keys()]).toEqual([registeredObject(e.sqlite, P, await sha256HexOf(bytes))!]);
  });

  it('S9: a restored copy named under a fresh generation outlives a delete its source issued before the restore', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    await capture(e, t.token);
    const snapshot = e.bucket.objects.get(registeredObject(e.sqlite, P, key)!)!;
    await release(e, key);
    const deletes = losingDeletes(e);
    deletes.lose(true);
    await drainObjectReleases(e.serverEnv, Date.now());
    // The restore owner: the ledger is cleared, the row is back and named under one fresh generation, and the
    // object is copied to the name the row now registers.
    registerBlob(e.sqlite, { projectId: P, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8', tokenId: t.tokenId, receivedAt: 0 });
    await resetRecoveryLedger(e.db);
    await assignRestoreGeneration(e.db, crypto.randomUUID());
    e.bucket.objects.set(registeredObject(e.sqlite, P, key)!, snapshot);
    await deletes.land();
    expect(journaled(e.sqlite)).toEqual([]);
    expect(lost(e)).toEqual([]);
  });
});

describe('release is one transaction with the references it judges', () => {
  const referenced = (e: Env, key: string) => e.sqlite.run(
    `INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
     VALUES (?, 'att-1', 's1', 'e1', ?, 'text/plain', 1, 1, 't', 1)`, [P, key]);

  it('keeps a blob a reference named first, and removes only the row whose own generation it journaled', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    await capture(e, t.token);
    referenced(e, key);
    // A stale journal row for another generation of the same content never removes the live row.
    const stale = blobObjectKey(P, key, crypto.randomUUID());
    e.sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES (?, 'upload', 1)`, [stale]);
    expect(await release(e, key)).toEqual({ released: 0, deferred: 0 });
    expect(registeredObject(e.sqlite, P, key)).not.toBeNull();
    expect(count(e.sqlite, 'blobs')).toBe(1);
    e.sqlite.run('DELETE FROM attachments');
    const live = registeredObject(e.sqlite, P, key)!;
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect((await release(e, key)).released).toBe(1);
    expect(journaled(e.sqlite)).toContain(live);
    expect(count(e.sqlite, 'blobs')).toBe(0);
  });

  it('refuses a reference arriving after the release, through the admission every reference writer carries', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const key = await sha256HexOf(bytes);
    await capture(e, t.token);
    await release(e, key);
    const envelope = {
      eventId: crypto.randomUUID(), sessionId: 's1', kind: 'attachment', createdAt: Date.now(), channel: 'cli',
      producer: { adapter: 'test', version: '1' }, payload: { attachmentId: crypto.randomUUID(), blob: key, description: 'late' },
    };
    const answer = await json(await worker.fetch(new Request('https://s/events', {
      method: 'POST', headers: memberHeaders(t.token, { 'content-type': 'application/json' }), body: JSON.stringify(envelope),
    }), e.env));
    expect(answer).toMatchObject({ persisted: false, code: 'blob_absent' });
    expect(count(e.sqlite, 'attachments')).toBe(0);
  });
});

describe('the one physical name', () => {
  it('spells the same name in TypeScript and in SQL, for a legacy row and a generation', async () => {
    const e = sqliteEnv();
    const key = 'a'.repeat(64);
    const generation = crypto.randomUUID();
    for (const held of [null, generation]) {
      const sql = (e.sqlite.query(`SELECT ${blobObjectKeySql('?', '?', '?')} AS k`).get(P, key, held) as { k: string }).k;
      expect(sql).toBe(blobObjectKey(P, key, held));
    }
    e.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?, ?, 1, 'text/plain', 't', 1, ?)`, [P, key, generation]);
    expect((e.sqlite.query(`SELECT ${registeredObjectKeySql('?', '?')} AS k`).get(P, key) as { k: string }).k).toBe(blobObjectKey(P, key, generation));
  });

  it('refuses a snapshot mapping outside the stored grammar rather than directing a copy elsewhere', () => {
    const key = 'b'.repeat(64);
    expect(snapshotBlobObject({ project_id: P, key, generation: null }).objectKey).toBe(`${P}/${key}`);
    for (const row of [
      { project_id: P, key, generation: '../../other' },
      { project_id: P, key, generation: 'A0000000-0000-4000-8000-000000000000' },
      { project_id: '../proj', key, generation: null },
      { project_id: P, key: 'not-a-digest', generation: null },
      { project_id: P, key, generation: 42 },
    ]) expect(() => snapshotBlobObject(row)).toThrow();
  });
});

describe('upload authority is the only way bytes become registered', () => {
  it('holds every refused, failed or expired upload to one outcome: its bytes are journaled or never written, and the quota is untouched', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    e.sqlite.run('UPDATE member_credentials SET bytes_written = ? WHERE id = ?', [MEMBER_TOKEN_BYTE_QUOTA - 1, t.tokenId]);
    expect(await capture(e, t.token)).toMatchObject({ stored: false, code: 'quota' });
    expect([e.bucket.puts, journaled(e.sqlite), count(e.sqlite, 'blob_reservations')]).toEqual([[], [], 0]);
    await drain(e);
    expect(lost(e)).toEqual([]);
    expect(unnamed(e)).toEqual([]);
  });
});

describe('a recovery hold keeps what a release would take, and a decision after it follows the rows and the policy as they stand', () => {
  const orphan = (e: Env, seed: number) => registerBlob(e.sqlite, { projectId: P, key: String(seed).padStart(64, '0'), size: 1 });
  const drainAll = async (e: Env, now: number) => {
    for (let pass = 0; pass < 64 && (count(e.sqlite, 'blob_release_candidates') + count(e.sqlite, 'backup_release_candidates') + count(e.sqlite, 'object_releases')) > 0; pass += 1) {
      await drainObjectReleases(e.serverEnv, now);
    }
  };

  it('advances the orphan sweep past every page a hold keeps, and releases all of them after the hold', async () => {
    const e = sqliteEnv();
    const total = TRANSCRIPT_RETENTION_BLOBS_PER_PASS * 3;
    for (let seed = 0; seed < total; seed += 1) orphan(e, seed);
    expect(await acquireRecoveryHold(e.db, 'hold-1', 1)).toBe(true);
    for (let pass = 0; pass < 10; pass += 1) await freeOrphanedBlobs(e.serverEnv, 2);
    expect(count(e.sqlite, 'blob_release_candidates')).toBe(total);
    await drainObjectReleases(e.serverEnv, 3);
    expect(count(e.sqlite, 'blobs')).toBe(total);
    expect(await releaseRecoveryHold(e.db, 'hold-1', 4, 'closed')).toBe(true);
    await drainAll(e, 5);
    expect([count(e.sqlite, 'blobs'), count(e.sqlite, 'blob_release_candidates'), count(e.sqlite, 'object_releases')]).toEqual([0, 0, 0]);
  });

  it('decides a candidate a reference named during the hold by that reference: the blob stays, and the candidate goes', async () => {
    const e = sqliteEnv();
    orphan(e, 1);
    const key = String(1).padStart(64, '0');
    await acquireRecoveryHold(e.db, 'hold-1', 1);
    expect(await releaseBlobs(e.db, [{ projectId: P, key }], 2)).toEqual({ released: 0, deferred: 1 });
    e.sqlite.run(`INSERT INTO attachments (project_id, attachment_id, session_id, event_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
                  VALUES (?, 'att', 's', 'e', ?, 'text/plain', 1, 1, 't', 1)`, [P, key]);
    // A second hold opening before the first is released is refused; the candidate survives every hold.
    expect(await acquireRecoveryHold(e.db, 'hold-2', 3)).toBe(false);
    await releaseRecoveryHold(e.db, 'hold-1', 4, 'closed');
    expect(await acquireRecoveryHold(e.db, 'hold-2', 5)).toBe(true);
    await drainAll(e, 6);
    expect(count(e.sqlite, 'blob_release_candidates')).toBe(1);
    await releaseRecoveryHold(e.db, 'hold-2', 7, 'closed');
    await drainAll(e, 8);
    expect([count(e.sqlite, 'blobs'), count(e.sqlite, 'blob_release_candidates'), count(e.sqlite, 'object_releases')]).toEqual([1, 0, 0]);
  });

  const DAY = 86_400_000;
  const retention = (e: Env, daily: number, weekly: number) => {
    for (const [leaf, value] of [['backup.retention.keep_daily', daily], ['backup.retention.keep_weekly', weekly]] as const) {
      e.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'm')
                    ON CONFLICT (leaf) DO UPDATE SET value = excluded.value`, [leaf, JSON.stringify(value)]);
    }
  };
  const backups = async (e: Env, now: number) => {
    const made = [];
    for (let day = 3; day >= 1; day -= 1) made.push(await createBackup(e.db, e.bucket, { producer: 'test', now: now - day * DAY }));
    return made;
  };

  it('releases a backup a hold kept only if retention, as configured when the hold ends, still lets it go', async () => {
    const e = sqliteEnv();
    const now = 100 * DAY;
    retention(e, 2, 0);
    const [oldest] = await backups(e, now);
    await acquireRecoveryHold(e.db, 'hold-1', now);
    expect(await pruneBackups(e.db, await backupRetentionPolicy(e.db), now)).toEqual({ pruned: 0 });
    expect(count(e.sqlite, 'backup_release_candidates')).toBe(1);
    retention(e, 3, 0);
    await releaseRecoveryHold(e.db, 'hold-1', now + 1, 'closed');
    await drainAll(e, now + 2);
    expect([count(e.sqlite, 'backups'), count(e.sqlite, 'backup_release_candidates'), e.bucket.deletes]).toEqual([3, 0, []]);
    expect(e.bucket.objects.has(oldest!.key)).toBe(true);
  });

  it('keeps a held victim when retention is turned off or the backup is pinned before the hold ends, and releases one the policy still lets go', async () => {
    const off = sqliteEnv();
    retention(off, 2, 0);
    await backups(off, 100 * DAY);
    await acquireRecoveryHold(off.db, 'hold-1', 100 * DAY);
    await pruneBackups(off.db, await backupRetentionPolicy(off.db), 100 * DAY);
    retention(off, 0, 0);
    await releaseRecoveryHold(off.db, 'hold-1', 100 * DAY, 'closed');
    await drainAll(off, 100 * DAY);
    expect([count(off.sqlite, 'backups'), off.bucket.deletes]).toEqual([3, []]);

    const pinned = sqliteEnv();
    retention(pinned, 2, 0);
    const [victim] = await backups(pinned, 100 * DAY);
    await acquireRecoveryHold(pinned.db, 'hold-1', 100 * DAY);
    await pruneBackups(pinned.db, await backupRetentionPolicy(pinned.db), 100 * DAY);
    pinned.sqlite.run('UPDATE backups SET pinned = 1 WHERE id = ?', [victim!.id]);
    await releaseRecoveryHold(pinned.db, 'hold-1', 100 * DAY, 'closed');
    await drainAll(pinned, 100 * DAY);
    expect([count(pinned.sqlite, 'backups'), pinned.bucket.deletes]).toEqual([3, []]);

    const kept = sqliteEnv();
    retention(kept, 2, 0);
    const [released] = await backups(kept, 100 * DAY);
    await acquireRecoveryHold(kept.db, 'hold-1', 100 * DAY);
    await pruneBackups(kept.db, await backupRetentionPolicy(kept.db), 100 * DAY);
    await releaseRecoveryHold(kept.db, 'hold-1', 100 * DAY, 'closed');
    await drainAll(kept, 100 * DAY);
    expect([count(kept.sqlite, 'backups'), kept.bucket.deletes]).toEqual([2, [released!.key]]);
  });

  it('clears the source lifecycle from a restored copy, keeping blob candidates to be judged again and dropping backup candidates', async () => {
    const e = sqliteEnv();
    orphan(e, 9);
    await acquireRecoveryHold(e.db, 'source-hold', 1);
    await releaseBlobs(e.db, [{ projectId: P, key: String(9).padStart(64, '0') }], 2);
    e.sqlite.run(`INSERT INTO backup_release_candidates (id, created_at) VALUES ('bk_source', 1)`);
    e.sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES ('proj_1/source', 'upload', 1)`);
    e.sqlite.run(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES (?, ?, ?, 't', 1, 9)`, [crypto.randomUUID(), P, 'a'.repeat(64)]);
    await resetRecoveryLedger(e.db);
    expect(['recovery_holds', 'object_releases', 'blob_reservations', 'backup_release_candidates', 'blob_release_candidates'].map((table) => count(e.sqlite, table)))
      .toEqual([0, 0, 0, 0, 1]);
  });
});

describe('the schema fence and rows from before it', () => {
  it('refuses a registration without a generation and a deletion of a generation row outside the journal, on the real statements', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    await capture(e, t.token);
    const key = await sha256HexOf(bytes);
    expect(() => e.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, 1, 'text/plain', 't', 1)`, [P, 'b'.repeat(64)]))
      .toThrow('blob rows register a generation');
    expect(() => e.sqlite.run('DELETE FROM blobs WHERE project_id = ? AND key = ?', [P, key])).toThrow('blob rows leave through the release journal');
    expect(registeredObject(e.sqlite, P, key)).not.toBeNull();
    // The release owner journals the exact object in the same transaction, which the fence admits.
    expect((await release(e, key)).released).toBe(1);
    expect(count(e.sqlite, 'blobs')).toBe(0);
  });

  it('reads, releases and deletes a row registered before step 42 by its legacy name, which the fence leaves unconstrained', async () => {
    const legacyKey = 'd'.repeat(64);
    const e = sqliteEnv({ beforeStep42: (db) => legacyBlob(db, { projectId: P, key: legacyKey, size: 6 }) });
    e.bucket.seed(`${P}/${legacyKey}`, { size: 6, bytes: utf8('legacy') });
    expect(registeredObject(e.sqlite, P, legacyKey)).toBe(`${P}/${legacyKey}`);
    expect(await freeOrphanedBlobs(e.serverEnv, Date.now())).toBe(1);
    expect(journaled(e.sqlite)).toEqual([`${P}/${legacyKey}`]);
    await drain(e);
    expect([count(e.sqlite, 'blobs'), e.bucket.objects.has(`${P}/${legacyKey}`)]).toEqual([0, false]);
  });
});
