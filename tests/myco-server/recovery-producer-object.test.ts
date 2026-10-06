/**
 * The hosted producer's own admission and hold settlement, over its real storage statements.
 *
 * The Durable Object class runs here against an in-memory SQLite that answers its storage calls the way the object's
 * SQLite storage does. The runtime proof on workerd is `runtime/recovery-producer-runtime.ts`.
 */
import { issueRecoveryForget } from '@myco-server-worker/core/recovery-forget.js';
import { MemberWriteRefused } from '@myco-server-worker/auth/member-write-store.js';
import { afterAll, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RecoveryProducer } from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js';
import { PRODUCER_LIMITS, PRODUCER_STALL_MS, type RecoveryAdmission } from '@myco-server-worker/core/recovery-producer.js';
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

const authorityStores = new Map<RecoveryProducer, ReturnType<typeof sqliteEnv>>();
afterAll(() => { for (const fixture of authorityStores.values()) fixture.sqlite.close(); });

async function forget(producer: RecoveryProducer) {
  const fixture = authorityStores.get(producer)!;
  return producer.forgetUnsettledExport(await issueRecoveryForget(fixture.db, 'mem_machine_1', Date.now(), (await producer.status()).unsettledExport ?? null));
}

function producerOver(
  sql: Database, writes: string[], put?: (key: string, body: Uint8Array) => Promise<{ size: number }>, doubles: Doubles = {},
  bindings: Record<string, string | undefined> = {},
) {
  const ctx = { storage: storage(sql, { delete: doubles.deleteSigned }) };
  const authority = sqliteEnv();
  const env = {
    MYCO_DB: authority.db,
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
  authorityStores.set(producer, authority);
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

it('keeps an export whose start was never answered as one no attempt sends another beside, across a restart and the next admission (#1480)', async () => {
  const sql = new Database(':memory:');
  const bindings = { HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_API_ORIGIN: 'http://127.0.0.1:9' };
  const producer = producerOver(sql, [], undefined, {}, bindings);
  const first = await producer.admit(admission('token-lost'));
  const sent: Array<string | null> = [];
  let answer: () => Response = () => { throw new TypeError('fetch failed'); };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { current_bookmark?: string }).current_bookmark ?? null);
    return answer();
  }) as typeof fetch;
  const requested = (id: number) => (sql.query('SELECT export_requested_at AS at, bookmark FROM attempts WHERE id = ?').get(id) as { at: number | null; bookmark: string | null });
  try {
    // The request that starts the export lands and its answer is lost.
    expect((await producer.continue()).error).toBe('provider_unavailable');
    expect({ sent, recorded: requested(first.attempt!).at !== null }).toEqual({ sent: [null], recorded: true });
    // After a restart of the object, and after that attempt ends and another is admitted, nothing asks again.
    expect((await producerOver(sql, [], undefined, {}, bindings).continue()).progressed).toBe(false);
    sql.run("UPDATE attempts SET stage = 'failed', error = 'provider_unavailable' WHERE id = ?", [first.attempt!]);
    const second = await producer.admit(admission('token-next'));
    expect(second.attempt).not.toBe(first.attempt);
    expect((await producer.continue()).progressed).toBe(false);
    expect(sent).toEqual([null]);
    // Once the window after that request has passed, the next attempt starts its own.
    sql.run('UPDATE attempts SET export_requested_at = ? WHERE id = ?', [Date.now() - PRODUCER_LIMITS.exportStaleMs - 1, first.attempt!]);
    answer = () => Response.json({ success: true, errors: [], result: { success: true, status: 'active', at_bookmark: 'bm-2' } });
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    expect(sent).toEqual([null, null]);
    expect(requested(second.attempt!)).toMatchObject({ bookmark: 'bm-2' });
    expect(requested(second.attempt!).at).not.toBeNull();
  } finally { globalThis.fetch = original; sql.close(); }
});

it('reports the wait on an unsettled export in its status, and asks once after an earlier attempt\'s stale export before starting another (#1484)', async () => {
  const sql = new Database(':memory:');
  const bindings = { HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_API_ORIGIN: 'http://127.0.0.1:9' };
  const producer = producerOver(sql, [], undefined, {}, bindings);
  const first = await producer.admit(admission('token-first'));
  const sent: Array<string | null> = [];
  let answer: (bookmark: string | null) => Response = () => { throw new TypeError('fetch failed'); };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bookmark = (JSON.parse(String(init?.body)) as { current_bookmark?: string }).current_bookmark ?? null;
    sent.push(bookmark);
    return answer(bookmark);
  }) as typeof fetch;
  const running = (bookmark: string) => Response.json({ success: true, errors: [], result: { success: true, status: 'active', at_bookmark: bookmark } });
  try {
    // Its own start unanswered: the status says it waits on its own request, not that a step stalled.
    await producer.continue();
    expect((await producer.status()).export?.waiting).toBe('own_request');

    // That attempt learns of its export and follows it, then ends; the next attempt waits on it by name.
    sql.run('UPDATE attempts SET export_requested_at = NULL WHERE id = ?', [first.attempt!]);
    answer = () => running('bm-1');
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    sql.run("UPDATE attempts SET stage = 'failed', error = 'export_stalled' WHERE id = ?", [first.attempt!]);
    const second = await producer.admit(admission('token-second'));
    await producer.continue();
    expect((await producer.status()).export?.waiting).toBe('earlier_export');
    // The wait is shown with the request instant of the export it waits on, which bounds it.
    const requestedAt = (sql.query('SELECT export_requested_at AS at FROM attempts WHERE id = ?').get(first.attempt!) as { at: number }).at;
    expect((await producer.status()).export?.waitingSince).toBe(requestedAt);

    // Past the window, it asks after that export once: still running, so it waits again and starts nothing.
    sql.run('UPDATE attempts SET export_answered_at = ? WHERE id = ?', [Date.now() - PRODUCER_LIMITS.exportStaleMs - 1, first.attempt!]);
    const before = sent.length;
    await producer.continue();
    expect(sent.slice(before)).toEqual(['bm-1']);
    expect((await producer.status()).export?.waiting).toBe('earlier_export');

    // Once it no longer runs, the next attempt starts its own.
    sql.run('UPDATE attempts SET export_answered_at = ? WHERE id = ?', [Date.now() - PRODUCER_LIMITS.exportStaleMs - 1, first.attempt!]);
    answer = (bookmark) => (bookmark === 'bm-1'
      ? Response.json({ success: true, errors: [], result: { success: true, status: 'error', error: 'gone' } })
      : running('bm-2'));
    const again = sent.length;
    // It settles that export, then reads the list again before starting its own (#1484 F3).
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    expect(sent.slice(again)).toEqual(['bm-1']);
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    expect(sent.slice(again)).toEqual(['bm-1', null]);
    expect(sql.query('SELECT export_requested_at AS at FROM attempts WHERE id = ?').get(first.attempt!)).toEqual({ at: null });
    expect((sql.query('SELECT bookmark FROM attempts WHERE id = ?').get(second.attempt!) as { bookmark: string }).bookmark).toBe('bm-2');
  } finally { globalThis.fetch = original; sql.close(); }
});

it('forgets an unsettled export at the owner\'s word once no attempt advances, and the next attempt starts its own (#1493 G3)', async () => {
  const sql = new Database(':memory:');
  const bindings = { HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_API_ORIGIN: 'http://127.0.0.1:9' };
  const producer = producerOver(sql, [], undefined, {}, bindings);
  const first = await producer.admit(admission('token-lost'));
  const sent: Array<string | null> = [];
  let answer: () => Response = () => { throw new TypeError('fetch failed'); };
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { current_bookmark?: string }).current_bookmark ?? null);
    return answer();
  }) as typeof fetch;
  const recorded = () => sql.query('SELECT COUNT(*) AS n FROM attempts WHERE export_requested_at IS NOT NULL').get();
  try {
    // The first attempt's start is lost, and the attempt after it waits on that export.
    await producer.continue();
    sql.run("UPDATE attempts SET stage = 'failed', error = 'provider_unavailable' WHERE id = ?", [first.attempt!]);
    const second = await producer.admit(admission('token-waiting'));
    expect((await producer.continue()).progressed).toBe(false);
    expect(sent).toEqual([null]);

    // While that attempt advances, nothing is forgotten.
    expect(await forget(producer)).toEqual({ refused: 'attempt_advancing', attempt: second.attempt! });
    expect(recorded()).toEqual({ n: 1 });

    // Once it fails on the wait, the export is still refused while its request or last answer falls inside the stale
    // window, when it may still run; the status and the refusal say from when it may be forgotten.
    sql.run("UPDATE attempts SET stage = 'failed', error = 'export_unsettled' WHERE id = ?", [second.attempt!]);
    const requestedAt = (sql.query('SELECT export_requested_at AS at FROM attempts WHERE id = ?').get(first.attempt!) as { at: number }).at;
    const from = requestedAt + PRODUCER_LIMITS.exportStaleMs;
    expect((await producer.status()).unsettledExport).toEqual({ attempt: first.attempt!, forgettableAt: from });
    expect(await forget(producer)).toEqual({ refused: 'export_recent', attempt: first.attempt!, forgettableAt: from });
    // Requested long ago but answered for lately: the window runs from its last word.
    sql.run('UPDATE attempts SET export_requested_at = ?, export_answered_at = ? WHERE id = ?', [Date.now() - 2 * PRODUCER_LIMITS.exportStaleMs, Date.now() - PRODUCER_LIMITS.exportStaleMs + 60_000, first.attempt!]);
    expect(await forget(producer)).toMatchObject({ refused: 'export_recent' });
    expect(recorded()).toEqual({ n: 1 });
    // Past the window from its last word, the owner's word forgets it, once.
    sql.run('UPDATE attempts SET export_requested_at = ?, export_answered_at = ? WHERE id = ?', [Date.now() - 2 * PRODUCER_LIMITS.exportStaleMs, Date.now() - PRODUCER_LIMITS.exportStaleMs - 1, first.attempt!]);
    const logged: string[] = [];
    const log = console.log;
    console.log = (line: unknown) => { logged.push(String(line)); };
    try {
      expect(await forget(producer)).toMatchObject({ forgotten: { attempt: first.attempt! } });
    } finally { console.log = log; }
    expect(logged.map((line) => (JSON.parse(line) as { kind: string }).kind)).toContain('recovery_export_forgotten');
    expect(recorded()).toEqual({ n: 0 });
    expect(await forget(producer)).toEqual({ forgotten: null });
    expect((await producer.status()).unsettledExport).toBeUndefined();

    // The next attempt starts its own export straight away.
    await producer.admit(admission('token-after'));
    answer = () => Response.json({ success: true, errors: [], result: { success: true, status: 'active', at_bookmark: 'bm-own' } });
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    expect(sent).toEqual([null, null]);
  } finally { globalThis.fetch = original; sql.close(); }
});

it('keeps the first answer that nothing is exporting on the attempt itself, apart from when the export last ran (#1497)', async () => {
  const sql = new Database(':memory:');
  const bindings = { HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_API_ORIGIN: 'http://127.0.0.1:9' };
  const producer = producerOver(sql, [], undefined, {}, bindings);
  const first = await producer.admit(admission('token-absent'));
  let answer: () => Response = () => Response.json({ success: true, errors: [], result: { success: true, status: 'active', at_bookmark: 'bm-1' } });
  const original = globalThis.fetch;
  globalThis.fetch = (async () => answer()) as unknown as typeof fetch;
  const row = () => sql.query('SELECT bookmark, export_answered_at AS answered, export_absent_at AS absent, re_exports AS reExports FROM attempts WHERE id = ?').get(first.attempt!) as { bookmark: string | null; answered: number | null; absent: number | null; reExports: number };
  try {
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    const ran = row();
    expect([ran.bookmark, ran.absent]).toEqual(['bm-1', null]);
    answer = () => Response.json({ success: true, errors: [], result: { success: false, error: 'Not currently exporting anything.' } });
    await producer.continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    const absent = row();
    // The window is recorded where it began, and the export's last word stays what it was.
    expect({ bookmark: absent.bookmark, answered: absent.answered, reExports: absent.reExports }).toEqual({ bookmark: 'bm-1', answered: ran.answered, reExports: 0 });
    expect(absent.absent).not.toBeNull();
    // Across a restart of the object the same window holds: the export is still followed.
    await producerOver(sql, [], undefined, {}, bindings).continue({ ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
    expect({ ...row(), absent: row().absent === absent.absent }).toEqual({ ...absent, absent: true });
  } finally { globalThis.fetch = original; sql.close(); }
});

for (const change of ['demotion', 'revocation'] as const) {
  it(`recovery command issuance refuses ${change} at its own commit`, async () => {
    let armed = false;
    const fixture = sqliteEnv({ onSql(sql, sqlite) {
      if (!armed || !/INSERT INTO recovery_forget_commands/.test(sql)) return;
      armed = false;
      sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id='mem_machine_1'" : "UPDATE members SET revoked_at=1 WHERE id='mem_machine_1'");
    } });
    try {
      armed = true;
      await expect(issueRecoveryForget(fixture.db, 'mem_machine_1', Date.now(), null)).rejects.toBeInstanceOf(MemberWriteRefused);
      expect(armed).toBe(false);
      expect(fixture.sqlite.query('SELECT * FROM recovery_forget_commands').all()).toEqual([]);
    } finally { fixture.sqlite.close(); }
  });
}

it('accepts only issued recovery commands, replays them once, and binds delayed commands to their export', async () => {
  const sql = new Database(':memory:');
  const producer = producerOver(sql, []);
  const fixture = authorityStores.get(producer)!;
  try {
    const first = await producer.admit(admission('export-first'));
    const old = Date.now() - 2 * PRODUCER_LIMITS.exportStaleMs;
    sql.run("UPDATE attempts SET stage='failed', export_requested_at=? WHERE id=?", [old, first.attempt!]);
    const target = (await producer.status()).unsettledExport!;
    const command = await issueRecoveryForget(fixture.db, 'mem_machine_1', Date.now(), target);
    const delayed = await issueRecoveryForget(fixture.db, 'mem_machine_1', Date.now(), target);
    expect(await producer.forgetUnsettledExport('unissued')).toEqual({ refused: 'not_admin' });
    expect((await producer.status()).unsettledExport).toEqual(target);
    const outcome = await producer.forgetUnsettledExport(command);
    expect(outcome).toMatchObject({ forgotten: { attempt: first.attempt! } });
    const second = await producer.admit(admission('export-second'));
    sql.run("UPDATE attempts SET stage='failed', export_requested_at=? WHERE id=?", [old, second.attempt!]);
    const before = sql.query('SELECT * FROM attempts').all();
    expect(await producer.forgetUnsettledExport(command)).toEqual(outcome);
    expect(await producer.forgetUnsettledExport(delayed)).toEqual({ forgotten: null });
    expect(sql.query('SELECT * FROM attempts').all()).toEqual(before);
  } finally { sql.close(); }
});
