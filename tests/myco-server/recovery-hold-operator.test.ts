/**
 * The operator recovery hold: the hold a full operator backup takes on the Deployment it is copying, beside the hold
 * this Deployment's own export producer takes.
 *
 * What these cover is what only the database can promise. A writer that predates schema step 43 releases a hold with
 * one statement, and that statement must not release an operator backup's hold, whatever state the row is in and
 * whichever open token the writer happens to select. Every reachable state is exercised, and the release transition is
 * total: a missing, null or unrecognised reason is refused rather than slipping through an untested predicate.
 */
import { describe, expect, it } from 'bun:test';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import type { RecoveryProducerPort } from '@myco-server-worker/core/recovery-producer.js';
import {
  acquireRecoveryHold, drainObjectReleases, openRecoveryHold, readRecoveryHold, releaseBlobs, releaseOperatorHold, releaseRecoveryHold,
} from '@myco-server-worker/core/object-release.js';
import {
  acquireOperatorHold, inspectOperatorHold, openOperatorHold, openHoldForAdmission, recoveryHoldRelease, settleOperatorHold, settleOpenHold,
} from '@myco-server-worker/core/recovery-hold.js';
import { count, sqliteEnv } from './helpers/fixtures.js';
import { registerBlob } from './helpers/d1.js';

/** The statement every release before step 43 ran: it names no holder and sets no discriminator. */
const RELEASE_BEFORE_43 = 'UPDATE recovery_holds SET released_at = ?, release_reason = ? WHERE token = ? AND released_at IS NULL';

/** A producer stand-in: it answers `closed` for the attempts it carries and retires every other token, as the real one does. */
const producer = (carried: readonly string[]): RecoveryProducerPort => ({
  admission: { ready: true },
  admit: async () => { throw new Error('this test admits nothing'); },
  status: async () => { throw new Error('this test reads no status'); },
  noteSchemaDrift: async () => { throw new Error('this test notes no drift'); },
  settleHold: async (token: string) => (carried.includes(token)
    ? { state: 'closed' as const, attempt: 1, stage: 'complete' as const }
    : { state: 'retired' as const }),
});

const row = (e: ReturnType<typeof sqliteEnv>, token: string) =>
  e.sqlite.query('SELECT token, holder, released_at, release_reason, released_by FROM recovery_holds WHERE token = ?').get(token) as Record<string, unknown> | null;

describe('the operator hold a full backup takes', () => {
  it('opens beside a producer hold, and neither blocks the other', async () => {
    const e = sqliteEnv();
    expect(await acquireOperatorHold(e.serverEnv, 'op-1', 10)).toBe(true);
    expect(await acquireOperatorHold(e.serverEnv, 'op-2', 11)).toBe(false);
    expect(await acquireRecoveryHold(e.db, 'prod-1', 12)).toBe(true);
    expect(await acquireRecoveryHold(e.db, 'prod-2', 13)).toBe(false);
    expect((await openRecoveryHold(e.db, 'operator'))?.token).toBe('op-1');
    expect((await openRecoveryHold(e.db, 'producer'))?.token).toBe('prod-1');
    expect(await openOperatorHold(e.serverEnv)).toEqual({ token: 'op-1', acquiredAt: 10 });
  });

  it('answers the same token idempotently, so a lost write is settled by asking again', async () => {
    const e = sqliteEnv();
    expect(await acquireOperatorHold(e.serverEnv, 'op-1', 10)).toBe(true);
    expect(await acquireOperatorHold(e.serverEnv, 'op-1', 11)).toBe(false);
    expect(await inspectOperatorHold(e.serverEnv, 'op-1')).toMatchObject({ state: 'open', acquiredAt: 10, releasedAt: null, releaseReason: null });
    expect(await settleOperatorHold(e.serverEnv, 'op-1', 20, 'complete')).toBe(true);
    expect(await settleOperatorHold(e.serverEnv, 'op-1', 21, 'complete')).toBe(false);
    expect(await inspectOperatorHold(e.serverEnv, 'op-1')).toMatchObject({ state: 'released', acquiredAt: 10, releasedAt: 20, releaseReason: 'complete' });
    // A released token is spent: it never opens a second hold.
    expect(await acquireOperatorHold(e.serverEnv, 'op-1', 30)).toBe(false);
    expect(await inspectOperatorHold(e.serverEnv, 'absent')).toMatchObject({ state: 'absent', acquiredAt: null, releasedAt: null, releaseReason: null });
    expect(await acquireRecoveryHold(e.db, 'prod-1', 31)).toBe(true);
    expect((await inspectOperatorHold(e.serverEnv, 'prod-1')).state).toBe('producer');
  });

  it('accepts only its own release: a missing, null or unrecognised reason is refused', async () => {
    const e = sqliteEnv();
    await acquireOperatorHold(e.serverEnv, 'op-1', 10);
    const refused = [
      () => e.sqlite.run("UPDATE recovery_holds SET released_at = 20, released_by = 'operator' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET released_at = 20, released_by = 'operator', release_reason = NULL WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET released_at = 20, released_by = 'operator', release_reason = '' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET released_at = 20, released_by = 'operator', release_reason = 'retired' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET release_reason = 'complete' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET released_by = 'operator' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET holder = 'producer' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET token = 'op-2' WHERE token = 'op-1'"),
      () => e.sqlite.run("UPDATE recovery_holds SET acquired_at = 99, released_at = 20, released_by = 'operator', release_reason = 'complete' WHERE token = 'op-1'"),
    ];
    for (const attempt of refused) expect(attempt).toThrow();
    expect(row(e, 'op-1')).toEqual({ token: 'op-1', holder: 'operator', released_at: null, release_reason: null, released_by: null });
    expect(await settleOperatorHold(e.serverEnv, 'op-1', 20, 'abandoned')).toBe(true);
    expect(row(e, 'op-1')).toEqual({ token: 'op-1', holder: 'operator', released_at: 20, release_reason: 'abandoned', released_by: 'operator' });
    // A released operator hold is final: it is neither reopened nor rewritten.
    expect(() => e.sqlite.run("UPDATE recovery_holds SET released_at = NULL, released_by = NULL, release_reason = NULL WHERE token = 'op-1'")).toThrow();
    expect(() => e.sqlite.run("UPDATE recovery_holds SET release_reason = 'complete' WHERE token = 'op-1'")).toThrow();
    expect(() => e.sqlite.run("INSERT INTO recovery_holds (token, acquired_at, holder, released_at, released_by, release_reason) VALUES ('op-3', 1, 'operator', 2, 'operator', 'complete')")).toThrow();
  });

  it('is never released by the statement every writer before step 43 runs, in any state it can be in', async () => {
    const e = sqliteEnv();
    const before43 = (token: string) => e.sqlite.run(RELEASE_BEFORE_43, [99, 'retired', token]);
    await acquireOperatorHold(e.serverEnv, 'op-1', 10);
    // Open.
    expect(() => before43('op-1')).toThrow();
    expect(await releaseRecoveryHold(e.db, 'op-1', 99, 'attempt 1 complete')).toBe(false);
    expect(row(e, 'op-1')?.released_at).toBeNull();
    // After each refused change, and beside a producer hold.
    expect(() => e.sqlite.run("UPDATE recovery_holds SET released_by = 'operator' WHERE token = 'op-1'")).toThrow();
    await acquireRecoveryHold(e.db, 'prod-1', 11);
    expect(() => before43('op-1')).toThrow();
    expect(row(e, 'op-1')?.released_at).toBeNull();
    // Released, and after replay.
    expect(await settleOperatorHold(e.serverEnv, 'op-1', 20, 'complete')).toBe(true);
    before43('op-1');
    expect(await acquireOperatorHold(e.serverEnv, 'op-1', 30)).toBe(false);
    expect(row(e, 'op-1')).toEqual({ token: 'op-1', holder: 'operator', released_at: 20, release_reason: 'complete', released_by: 'operator' });
    // The same statement still releases a producer hold, which is what it is for.
    before43('prod-1');
    expect(row(e, 'prod-1')?.released_at).toBe(99);
  });

  it('is never settled against the producer, whichever open token settlement selects', async () => {
    const e = sqliteEnv();
    await acquireOperatorHold(e.serverEnv, 'op-1', 10);
    await acquireRecoveryHold(e.db, 'prod-1', 11);
    // The selection is unspecified: the statement has no ORDER BY, so both are exercised by narrowing it.
    for (const holder of ['operator', 'producer'] as const) {
      const narrowed = {
        ...e.serverEnv,
        db: {
          ...e.db,
          prepare: (sql: string) => e.db.prepare(sql.includes('FROM recovery_holds WHERE released_at IS NULL') ? `${sql} AND holder = '${holder}'` : sql),
        },
      } as typeof e.serverEnv;
      const settled = await settleOpenHold({ ...narrowed, recovery: producer(['prod-1']) }, 12).catch((error: unknown) => error);
      expect(row(e, 'op-1')?.released_at).toBeNull();
      if (holder === 'producer') expect(settled).toMatchObject({ state: 'closed' });
      await e.sqlite.run("UPDATE recovery_holds SET released_at = NULL, release_reason = NULL, released_by = NULL WHERE token = 'prod-1' AND holder = 'producer'");
    }
    // This release's own settlement only ever reads producer holds, so an operator hold asks the producer nothing.
    await e.sqlite.run("UPDATE recovery_holds SET released_at = 13, release_reason = 'done', released_by = 'producer' WHERE token = 'prod-1'");
    let asked = 0;
    const counting: RecoveryProducerPort = { ...producer([]), settleHold: async (token: string) => { asked += 1; return producer([]).settleHold(token); } };
    expect(await settleOpenHold({ ...e.serverEnv, recovery: counting }, 14)).toBeNull();
    expect(await recoveryHoldRelease({ ...e.serverEnv, recovery: counting }, 15)).toBe(0);
    expect([asked, row(e, 'op-1')?.released_at]).toEqual([0, null]);
  });

  it('lets an admission open its own hold while an operator backup holds this Deployment', async () => {
    const e = sqliteEnv();
    await acquireOperatorHold(e.serverEnv, 'op-1', 10);
    const admitted = await openHoldForAdmission({ ...e.serverEnv, recovery: producer([]) }, 11);
    expect(admitted).toHaveProperty('token');
    expect(row(e, 'op-1')?.released_at).toBeNull();
    expect((await openRecoveryHold(e.db, 'producer'))?.token).toBe((admitted as { token: string }).token);
  });

  it('defers every deletion while it is open, and the drain decides them once it is released', async () => {
    const e = sqliteEnv();
    const key = 'a'.repeat(64);
    registerBlob(e.sqlite, { projectId: 'proj_1', key, size: 3 });
    await acquireOperatorHold(e.serverEnv, 'op-1', 10);
    expect(await releaseBlobs(e.db, [{ projectId: 'proj_1', key }], 11)).toEqual({ released: 0, deferred: 1 });
    await drainObjectReleases(e.serverEnv, 12);
    expect([count(e.sqlite, 'blobs'), count(e.sqlite, 'object_releases'), count(e.sqlite, 'blob_release_candidates')]).toEqual([1, 0, 1]);
    expect(await settleOperatorHold(e.serverEnv, 'op-1', 13, 'complete')).toBe(true);
    for (let pass = 0; pass < 4; pass += 1) await drainObjectReleases(e.serverEnv, 14 + pass);
    expect([count(e.sqlite, 'blobs'), count(e.sqlite, 'object_releases'), count(e.sqlite, 'blob_release_candidates')]).toEqual([0, 0, 0]);
  });

  it('carries every hold a step-42 volume already had, as a producer hold', async () => {
    const e = sqliteEnv({ beforeStep42: () => {} });
    expect(Number((e.sqlite.query("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string }).value)).toBe(SERVER_SCHEMA_VERSION);
    e.sqlite.run('INSERT INTO recovery_holds (token, acquired_at) VALUES (?, ?)', ['legacy', 1]);
    expect((await readRecoveryHold(e.db, 'legacy')).hold).toEqual({ token: 'legacy', holder: 'producer', acquiredAt: 1, releasedAt: null, releaseReason: null });
    expect(await releaseOperatorHold(e.db, 'legacy', 2, 'complete')).toBe(false);
    expect(await releaseRecoveryHold(e.db, 'legacy', 3, 'attempt 1 complete')).toBe(true);
  });
});
