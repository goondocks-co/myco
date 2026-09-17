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
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { sqliteEnv } from './helpers/fixtures.js';

function storage(sql: Database, signed: { delete?: (key: string) => Promise<boolean> } = {}) {
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
    delete: signed.delete ?? (async () => true),
  };
}

/** A producer over `sql`, as a fresh instance of the object sees its storage after a restart. */
interface Doubles {
  abort?: () => Promise<void>;
  deleteSigned?: (key: string) => Promise<boolean>;
}

/** The configuration a deployment record renders for this producer's own bindings. */
const RECORDED_CONFIGURATION = {
  accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', databaseName: 'fixture-db', workerName: 'fixture-worker',
  bucketName: 'fixture-blobs', recoveryBucketName: 'fixture-worker-recovery', vectorIndexName: 'fixture-vectors', wrapKeySecretName: 'fixture-wrap',
  storeId: 'b'.repeat(32),
};

function producerOver(
  sql: Database, writes: string[], put?: (key: string, body: Uint8Array) => Promise<{ size: number }>, doubles: Doubles = {},
  bindings: Record<string, string | undefined> = {},
) {
  const ctx = { storage: storage(sql, { delete: doubles.deleteSigned }) };
  const env = {
    MYCO_RECOVERY_ACCOUNT_ID: 'a'.repeat(32), MYCO_RECOVERY_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
    MYCO_RECOVERY_CONFIGURATION: JSON.stringify(RECORDED_CONFIGURATION),
    ...bindings,
    RECOVERY_EXPORT_TOKEN: 'never-sent', BUCKET: { get: async () => null },
    RECOVERY_BUCKET: {
      put: put ?? (async (key: string, body: Uint8Array) => { writes.push(key); return { size: body.length }; }),
      resumeMultipartUpload: () => ({ abort: doubles.abort ?? (async () => undefined) }),
    },
  };
  const producer = new RecoveryProducer(ctx as never, env as never);
  Object.assign(producer, { ctx, env });
  return producer;
}

const admission = (holdToken: string): RecoveryAdmission => ({
  holdToken, tables: ['example'], schema: '[]', captured: { example: 'CREATE TABLE example(id INTEGER)' }, startedBy: 'mem_owner',
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
  sql.run("UPDATE attempts SET last_progress_at = ?, upload_id = 'upload-in-flight' WHERE id = ?", [Date.now() - PRODUCER_STALL_MS - 1, first.attempt]);
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { logged.push(String(line)); };
  try {
    expect(await producer.settleHold('token-stall')).toEqual({ state: 'closed', attempt: first.attempt!, stage: 'failed' });
  } finally { console.log = log; }
  // The stalled attempt is failed through the one failure path: terminal first, its upload and signed download cleared,
  // and the refusal announced with what its clean-up reached.
  expect(sql.query('SELECT stage, error, upload_id FROM attempts WHERE id = ?').get(first.attempt!)).toEqual({ stage: 'failed', error: 'producer_stalled', upload_id: null });
  const announced = logged.map((line) => JSON.parse(line) as Record<string, unknown>).find((event) => event.kind === 'recovery_attempt_failed');
  expect(announced).toMatchObject({ refusal: 'producer_stalled', attempt: first.attempt, stage: 'copy', signedUrlCleared: true });
  expect(typeof announced?.uploadAborted).toBe('boolean');

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

/** The refusal events a call emits, read from the one telemetry sink. */
async function announced(work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
  const logged: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { logged.push(String(line)); };
  try { await work(); } finally { console.log = log; }
  return logged.map((line) => JSON.parse(line) as Record<string, unknown>).filter((event) => event.kind === 'recovery_attempt_failed');
}

it('bounds each clean-up step of a stalled attempt on its own: a hung abort still clears the signed download and announces the truth, and a late abort changes nothing', async () => {
  for (const hung of ['abort', 'signed'] as const) {
    const sql = new Database(':memory:');
    let lateAbort!: () => void;
    let lateDelete!: (value: boolean) => void;
    const deletes: string[] = [];
    const producer = producerOver(sql, [], undefined, {
      abort: hung === 'abort' ? () => new Promise<void>((resolve) => { lateAbort = resolve; }) : async () => undefined,
      deleteSigned: async (key) => {
        deletes.push(key);
        return hung === 'signed' ? new Promise<boolean>((resolve) => { lateDelete = resolve; }) : true;
      },
    });
    const first = await producer.admit(admission(`token-${hung}`));
    sql.run("UPDATE attempts SET stage = 'download', upload_id = 'upload-in-flight', last_progress_at = ? WHERE id = ?", [Date.now() - PRODUCER_STALL_MS - 1, first.attempt]);
    const started = Date.now();
    const events = await announced(() => producer.settleHold(`token-${hung}`, { requestMs: 40 }));
    expect({ hung, elapsedBounded: Date.now() - started < 2_000 }).toEqual({ hung, elapsedBounded: true });
    expect(sql.query('SELECT stage, error, upload_id FROM attempts').get()).toEqual({ stage: 'failed', error: 'producer_stalled', upload_id: null });
    expect(events).toEqual([expect.objectContaining({
      refusal: 'producer_stalled', attempt: first.attempt, uploadAborted: hung !== 'abort', signedUrlCleared: hung !== 'signed',
    })]);
    // The signed download is asked to clear even when the abort before it never settled.
    expect(deletes).toEqual([`signed:${first.attempt}`]);
    if (hung === 'abort') lateAbort(); else lateDelete(true);
    await Bun.sleep(10);
    expect(sql.query('SELECT stage, error, upload_id FROM attempts').get()).toEqual({ stage: 'failed', error: 'producer_stalled', upload_id: null });
    expect((await producer.settleHold(`token-${hung}`)).state).toBe('closed');
    sql.close();
  }
});

it('stages this Deployment\'s bound configuration, who started the attempt, and every recovery credential name', async () => {
  const sql = new Database(':memory:');
  const bodies = new Map<string, string>();
  const producer = producerOver(sql, [], async (key, body) => { bodies.set(key, new TextDecoder().decode(body)); return { size: body.length }; });
  const admitted = await producer.admit(admission('token-staged'));
  expect(admitted.stage).toBe('export');
  const [manifestKey] = [...bodies.keys()].filter((key) => key.endsWith('/recovery.json'));
  const manifest = JSON.parse(bodies.get(manifestKey!)!);
  expect(manifest.configuration).toEqual({ ...RECORDED_CONFIGURATION, startedBy: 'mem_owner' });
  expect(manifest.credentialsRequired).toEqual([...RECOVERY_CREDENTIAL_NAMES]);
  // The bound export credential is a runtime secret: no staged metadata carries it.
  for (const body of bodies.values()) expect(body).not.toContain('never-sent');
  // A restarted instance reads the same admission back from its own row.
  expect((await producerOver(sql, []).admit(admission('token-staged'))).attempt).toBe(admitted.attempt);
});

it.each([
  ['no rendered configuration', { MYCO_RECOVERY_CONFIGURATION: undefined }],
  ['a configuration naming a fleet the runtime does not run with', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...RECORDED_CONFIGURATION, fleet: 4 }), MYCO_FLEET: '2' }],
  ['a configuration naming another address', { MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ ...RECORDED_CONFIGURATION, url: 'https://old.example.test' }), MYCO_ORIGIN: 'https://new.example.test' }],
])('stages nothing for a new attempt with %s, while replay, status and hold settlement still answer', async (_label, bindings) => {
  const sql = new Database(':memory:');
  const writes: string[] = [];
  const configured = producerOver(sql, writes);
  const first = await configured.admit(admission('token-before'));
  const staged = writes.length;
  const unconfigured = producerOver(sql, writes, undefined, {}, bindings);
  // The attempt admitted before still answers its own token, its status and its hold.
  expect((await unconfigured.admit(admission('token-before'))).attempt).toBe(first.attempt);
  expect((await unconfigured.status()).attempt).toBe(first.attempt);
  expect((await unconfigured.settleHold('token-before')).state).toBe('open');
  expect(writes.length).toBe(staged);

  const fresh = new Database(':memory:');
  const freshWrites: string[] = [];
  const refusing = producerOver(fresh, freshWrites, undefined, {}, bindings);
  await expect(refusing.admit(admission('token-new'))).rejects.toThrow(/recovery configuration/);
  expect(freshWrites).toEqual([]);
  expect((await refusing.status()).attempt).toBeNull();
  expect((await refusing.settleHold('token-new')).state).toBe('retired');
});

it('stages an admission from a previous Worker under this object\'s own configuration, keeping who started it', async () => {
  const sql = new Database(':memory:');
  const bodies = new Map<string, string>();
  const producer = producerOver(sql, [], async (key, body) => { bodies.set(key, new TextDecoder().decode(body)); return { size: body.length }; });
  const { startedBy: _startedBy, ...current } = admission('token-previous');
  const previous = { ...current, configuration: { startedBy: 'previous-owner' }, credentialsRequired: [] as string[] };
  expect((await producer.admit(previous)).stage).toBe('export');
  const manifests = [...bodies.entries()].filter(([key]) => key.endsWith('/recovery.json')).map(([, body]) => JSON.parse(body));
  expect(manifests.map((manifest) => [manifest.configuration, manifest.credentialsRequired]))
    .toEqual([[{ ...RECORDED_CONFIGURATION, startedBy: 'previous-owner' }, [...RECOVERY_CREDENTIAL_NAMES]]]);
});

it('answers a token replayed in the other wire shape with the attempt it first admitted, staging and relabelling nothing', async () => {
  for (const firstPrevious of [true, false]) {
    const sql = new Database(':memory:');
    const puts: Array<[string, string]> = [];
    const put = async (key: string, body: Uint8Array) => { puts.push([key, new TextDecoder().decode(body)]); return { size: body.length }; };
    const { startedBy: _startedBy, ...bare } = admission('token-replayed');
    const previousShape = { ...bare, configuration: { startedBy: 'previous-owner' }, credentialsRequired: [] as string[] };
    const currentShape = { ...admission('token-replayed'), startedBy: 'current-owner' };
    const first = await producerOver(sql, [], put).admit(firstPrevious ? previousShape : currentShape);
    const staged = [...puts];
    for (const held of [producerOver(sql, [], put), producerOver(sql, [], put)]) {
      const again = await held.admit(firstPrevious ? currentShape : previousShape);
      expect([again.attempt, again.stage]).toEqual([first.attempt, 'export']);
    }
    expect(puts).toEqual(staged);
    expect(sql.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    const recorded = JSON.parse((sql.query('SELECT admission FROM attempts').get() as { admission: string }).admission);
    expect(recorded.configuration.startedBy).toBe(firstPrevious ? 'previous-owner' : 'current-owner');
    sql.close();
  }
});

it.each([
  ['no rendered configuration', { MYCO_RECOVERY_CONFIGURATION: undefined }],
  ['a stale rendered configuration', { MYCO_FLEET: '9' }],
])('through the actual Cloudflare port with %s, answers a carried or retired token and refuses a fresh one before staging', async (_label, bindings) => {
  const sql = new Database(':memory:');
  const writes: string[] = [];
  const configured = producerOver(sql, writes);
  const first = await configured.admit(admission('token-carried'));
  expect(await configured.settleHold('token-retired')).toEqual({ state: 'retired' });
  const staged = writes.length;
  for (const object of [configured, producerOver(sql, writes, undefined, {}, bindings)]) {
    const e = sqliteEnv();
    try {
      const port = serverEnvFromBindings({
        ...e.env, MYCO_RECOVERY_ACCOUNT_ID: 'a'.repeat(32), MYCO_RECOVERY_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
        MYCO_RECOVERY_CONFIGURATION: JSON.stringify(RECORDED_CONFIGURATION), ...bindings,
        RECOVERY: { idFromName: (name: string) => name, get: () => object }, RECOVERY_BUCKET: {},
      } as never).recovery!;
      expect(port.admission.ready).toBe(false);
      const replayed = await port.admit(admission('token-carried'));
      expect([replayed.attempt, replayed.stage]).toEqual([first.attempt, 'export']);
      expect((await port.admit(admission('token-retired'))).holdRetired).toBe(true);
      // With an attempt advancing, a fresh token is answered with that attempt's progress; once it rests, it is refused.
      sql.run("UPDATE attempts SET stage = 'downloaded' WHERE id = ?", [first.attempt]);
      await expect(port.admit(admission(`token-fresh-${writes.length}`))).rejects.toThrow(/recovery configuration/);
      sql.run("UPDATE attempts SET stage = 'export' WHERE id = ?", [first.attempt]);
      expect(writes.length).toBe(staged);
      expect(sql.query('SELECT COUNT(*) AS n FROM attempts').get()).toEqual({ n: 1 });
    } finally { e.sqlite.close(); }
  }
  sql.close();
});
