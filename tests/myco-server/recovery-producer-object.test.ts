/**
 * The hosted producer's own admission and hold settlement, over its real storage statements.
 *
 * The Durable Object class runs here against an in-memory SQLite that answers its storage calls the way the object's
 * SQLite storage does. The runtime proof on workerd is `runtime/recovery-producer-runtime.ts`.
 */
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RecoveryProducer } from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js';
import { PRODUCER_STALL_MS, type RecoveryAdmission } from '@myco-server-worker/core/recovery-producer.js';
import { settleOpenHold } from '@myco-server-worker/core/recovery-hold.js';
import { Stalled } from '@myco-server-worker/core/recovery-inventory.js';
import { acquireRecoveryHold } from '@myco-server-worker/core/object-release.js';
import { sqliteEnv } from './helpers/fixtures.js';

function storage(sql: Database) {
  return {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        const prepared = sql.query(query);
        const rows = prepared.columnNames.length > 0 ? prepared.all(...(bindings as never[])) : (prepared.run(...(bindings as never[])), []);
        return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('expected one row'); return rows[0]; } };
      },
    },
    transactionSync: <T>(work: () => T): T => sql.transaction(work)(),
    get: async () => undefined,
    delete: async () => true,
  };
}

/** A producer over `sql`, as a fresh instance of the object sees its storage after a restart. */
function producerOver(sql: Database, writes: string[], put?: (key: string, body: Uint8Array) => Promise<{ size: number }>) {
  const ctx = { storage: storage(sql) };
  const env = {
    MYCO_RECOVERY_ACCOUNT_ID: 'a'.repeat(32), MYCO_RECOVERY_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
    RECOVERY_EXPORT_TOKEN: 'never-sent', BUCKET: { get: async () => null },
    RECOVERY_BUCKET: { put: put ?? (async (key: string, body: Uint8Array) => { writes.push(key); return { size: body.length }; }) },
  };
  const producer = new RecoveryProducer(ctx as never, env as never);
  Object.assign(producer, { ctx, env });
  return producer;
}

const admission = (holdToken: string): RecoveryAdmission => ({
  holdToken, tables: ['example'], schema: '[]', captured: { example: 'CREATE TABLE example(id INTEGER)' }, configuration: {}, credentialsRequired: [],
});

it('answers an admission replayed with a carried token with its own attempt at every stage and across a restart, staging nothing again', async () => {
  const sql = new Database(':memory:');
  const writes: string[] = [];
  const producer = producerOver(sql, writes);
  const first = await producer.admit(admission('token-1'));
  expect(first.stage).toBe('export');
  const staged = writes.length;
  for (const stage of ['export', 'download', 'inventory', 'copy', 'downloaded', 'complete', 'unconfirmed', 'failed']) {
    sql.run('UPDATE attempts SET stage = ? WHERE id = ?', [stage, first.attempt]);
    const settled = await producer.settleHold('token-1');
    expect(settled.state).toBe(['export', 'download', 'inventory', 'copy'].includes(stage) ? 'open' : 'closed');
    for (const held of [producer, producerOver(sql, writes)]) {
      const again = await held.admit(admission('token-1'));
      expect({ stage, attempt: again.attempt, answered: again.stage as string }).toEqual({ stage, attempt: first.attempt!, answered: stage });
    }
  }
  expect(writes.length).toBe(staged);
  expect(sql.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
  sql.close();
});

it('refuses a retired token for ever, across a restart, and admits a fresh token once no attempt advances', async () => {
  const sql = new Database(':memory:');
  const writes: string[] = [];
  const producer = producerOver(sql, writes);
  expect(await producer.settleHold('never-admitted')).toEqual({ state: 'retired' });
  expect((await producerOver(sql, writes).admit(admission('never-admitted'))).holdRetired).toBe(true);
  expect(sql.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  expect(writes).toEqual([]);
  const fresh = await producer.admit(admission('fresh'));
  expect([fresh.stage, fresh.holdRetired]).toEqual(['export', undefined]);
  sql.close();
});

it('holds the one-attempt-per-token rule in storage, and leaves attempts admitted before tokens unconstrained', async () => {
  const sql = new Database(':memory:');
  const producer = producerOver(sql, []);
  const first = await producer.admit(admission('token-1'));
  // Two legacy attempts, admitted before tokens existed, carry none.
  for (const prefix of ['staging/legacy-1', 'staging/legacy-2']) {
    sql.run(`INSERT INTO attempts (stage, prefix, locator, started_at, scan) SELECT 'downloaded', ?, locator, 1, scan FROM attempts WHERE id = ?`, [prefix, first.attempt]);
  }
  expect(() => sql.run(`INSERT INTO attempts (stage, prefix, locator, started_at, scan, hold_token) SELECT 'export', 'staging/copy', locator, 1, scan, hold_token FROM attempts WHERE id = ?`, [first.attempt]))
    .toThrow('UNIQUE constraint failed');
  expect(sql.query('SELECT COUNT(*) AS n FROM attempts WHERE hold_token IS NULL').get()).toEqual({ n: 2 });
  sql.close();
});

it('bounds an admission whose staging write never settles: the gate is released, settlement answers, and a late write admits nothing', async () => {
  const sql = new Database(':memory:');
  const late: Array<() => void> = [];
  const hanging = (_key: string, body: Uint8Array) => new Promise<{ size: number }>((resolve) => { late.push(() => resolve({ size: body.length })); });
  const producer = producerOver(sql, [], hanging);
  await expect(producer.admit(admission('token-hung'), { requestMs: 50 })).rejects.toBeInstanceOf(Stalled);
  // Settlement is not queued behind the hung write: it answers, and retires the token no attempt carries.
  expect(await producer.settleHold('token-hung')).toEqual({ state: 'retired' });
  for (const land of late) land();
  await Bun.sleep(10);
  expect(sql.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 0 });
  expect((await producer.admit(admission('token-hung'))).holdRetired).toBe(true);
  sql.close();
});

it('fails an attempt that commits no checkpoint for the stall bound, durably, and refuses the late writes of a step that outlived it', async () => {
  const sql = new Database(':memory:');
  const producer = producerOver(sql, []);
  const first = await producer.admit(admission('token-stall'));
  sql.run("UPDATE attempts SET stage = 'copy', last_progress_at = ? WHERE id = ?", [Date.now() - PRODUCER_STALL_MS + 60_000, first.attempt]);
  expect((await producer.settleHold('token-stall')).state).toBe('open');
  sql.run('UPDATE attempts SET last_progress_at = ? WHERE id = ?', [Date.now() - PRODUCER_STALL_MS - 1, first.attempt]);
  expect(await producer.settleHold('token-stall')).toEqual({ state: 'closed', attempt: first.attempt!, stage: 'failed' });
  expect(sql.query('SELECT stage, error FROM attempts WHERE id = ?').get(first.attempt!)).toEqual({ stage: 'failed', error: 'producer_stalled' });

  // A continuation step already in flight completes after the terminalization: none of its writes revive the attempt.
  const checkpoint = (producer as unknown as { checkpoint(): import('@myco-server-worker/core/recovery-producer.js').AttemptCheckpoint }).checkpoint();
  checkpoint.update(first.attempt!, { stage: 'complete', completedAt: Date.now() });
  checkpoint.recordCopied(first.attempt!, 'proj_1/key', { sha256: 'a'.repeat(64), bytes: 1 });
  checkpoint.recordPart(first.attempt!, { part: 1, bytes: 1, sha256: 'b'.repeat(64), etag: 'e' }, 1, { defined: {}, scan: JSON.parse((sql.query('SELECT scan FROM attempts').get() as { scan: string }).scan), scanBytes: '' } as never);
  expect(sql.query('SELECT stage, error FROM attempts WHERE id = ?').get(first.attempt!)).toEqual({ stage: 'failed', error: 'producer_stalled' });
  expect(sql.query('SELECT COUNT(*) AS n FROM parts').get()).toEqual({ n: 0 });
  // Across a restart the terminal attempt stays terminal, and a continuation finds nothing to advance.
  const restarted = producerOver(sql, []);
  expect((await restarted.continue()).attempt).toBeNull();
  expect((await restarted.admit(admission('token-stall'))).stage).toBe('failed');
  sql.close();
});

it('keeps a hold whose settlement does not answer within its bound, and settles it once the producer answers', async () => {
  const env = sqliteEnv();
  const token = crypto.randomUUID();
  expect(await acquireRecoveryHold(env.db, token, 1)).toBe(true);
  const hung = { settleHold: () => new Promise<never>(() => {}) };
  expect(await settleOpenHold({ db: env.db, recovery: hung as never }, 2, 50)).toBe('unverified');
  expect(env.sqlite.query('SELECT released_at FROM recovery_holds').get()).toEqual({ released_at: null });
  const answering = { settleHold: async () => ({ state: 'retired' as const }) };
  expect(await settleOpenHold({ db: env.db, recovery: answering as never }, 3, 50)).toEqual({ state: 'retired' });
  expect(env.sqlite.query('SELECT released_at, release_reason FROM recovery_holds').get()).toEqual({ released_at: 3, release_reason: 'retired' });
  env.sqlite.close();
});
