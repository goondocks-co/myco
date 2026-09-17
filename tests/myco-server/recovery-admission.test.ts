/**
 * The owner surface: what admission captures before an export runs, what it refuses, what it wakes, and what a
 * status answer may claim. The producer itself is a stand-in here; its own behaviour is proven in its own suites.
 */
import { registerBlob } from './helpers/d1.js';
import { expect, it } from 'bun:test';
import { handleRecoveryExportStatus, handleStartRecoveryExport } from '@myco-server-worker/api/recovery.js';
import { settlementOf, type AttemptStage, type RecoveryAdmission, type RecoveryAdmissionReadiness, type RecoveryProducerStatus } from '@myco-server-worker/core/recovery-producer.js';
import { drainObjectReleases, releaseBlobs } from '@myco-server-worker/core/object-release.js';
import { recoveryHoldRelease } from '@myco-server-worker/core/recovery-hold.js';
import { sqliteEnv } from './helpers/fixtures.js';

const OWNER = { member: { id: 'owner-1' }, now: 1_000 } as never;

const idle: RecoveryProducerStatus = {
  attempt: null, stage: 'idle', recoverable: false, staged: null, export: null, error: null, transientSpent: 0, stagedSchema: null,
};

function producer() {
  const seen: RecoveryAdmission[] = [];
  let status: RecoveryProducerStatus = idle;
  const carried = new Map<string, { id: number; stage: AttemptStage }>();
  const retired = new Set<string>();
  return {
    seen, carried, retired,
    set: (next: Partial<RecoveryProducerStatus>) => { status = { ...idle, ...next }; },
    port: {
      admission: { ready: true } as RecoveryAdmissionReadiness,
      admit: async (admission: RecoveryAdmission) => {
        if (retired.has(admission.holdToken)) return { ...status, holdRetired: true as const };
        seen.push(admission);
        status = { ...idle, attempt: seen.length, stage: 'export' as const };
        carried.set(admission.holdToken, { id: seen.length, stage: 'export' });
        return status;
      },
      settleHold: async (token: string) => {
        const settlement = settlementOf(carried.get(token) ?? null);
        if (settlement.state === 'retired') retired.add(token);
        return settlement;
      },
      status: async () => status,
      noteSchemaDrift: async () => { throw new Error('a status read must not mutate an attempt'); },
    },
  };
}

it('captures the schema before any export, names its tables, and wakes the Deployment it admitted on', async () => {
  const env = sqliteEnv();
  const held = producer();
  const wakes: number[] = [];
  const response = await handleStartRecoveryExport(
    { ...env.serverEnv, recovery: held.port, wake: async () => { wakes.push(1); } } as never, OWNER,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect([body.stage, body.recoverable]).toEqual(['export', false]);
  expect(String(body.usable)).toContain('materializes');
  expect(wakes).toEqual([1]);

  const [admission] = held.seen;
  expect(admission!.tables).toContain('sessions');
  expect(admission!.tables).toContain('sqlite_sequence');
  const captured = JSON.parse(admission!.schema) as Array<{ name: string; type: string; storage: string | null }>;
  expect(captured.some((row) => row.name === 'sessions' && row.type === 'table')).toBe(true);
  expect(captured.some((row) => row.name === 'sessions_fts')).toBe(true);
  // The definitions the export is later held to travel with the admission, taken from the same capture: one
  // definition per ordinary table, and none for an index, a view or a virtual table.
  const definitions = admission!.captured;
  expect(Object.keys(definitions).sort()).toEqual(captured.filter((row) => row.storage === 'table').map((row) => row.name).sort());
  expect(definitions.sessions).toContain('CREATE TABLE');
  env.sqlite.close();
});

it('refuses a schema this recovery cannot reconstruct, before an export pauses anything', async () => {
  const env = sqliteEnv();
  env.sqlite.exec("CREATE VIRTUAL TABLE opaque_fts USING fts5(body)");
  const held = producer();
  const response = await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  expect(response.status).toBe(400);
  expect(String((await response.json() as { reason?: string }).reason)).toContain('cannot reconstruct virtual table opaque_fts');
  expect(held.seen).toEqual([]);
  env.sqlite.close();
});

it('says plainly that a Deployment with no producer runs none', async () => {
  const env = sqliteEnv();
  for (const handler of [handleStartRecoveryExport, handleRecoveryExportStatus]) {
    const response = await handler({ ...env.serverEnv, recovery: undefined } as never, OWNER);
    expect(response.status).toBe(400);
    expect(String((await response.json() as { reason?: string }).reason)).toContain('runs no hosted recovery producer');
  }
  env.sqlite.close();
});

it('reads a status without touching the attempt or claiming recoverability', async () => {
  const env = sqliteEnv();
  const held = producer();
  held.set({ attempt: 2, stage: 'complete', staged: { prefix: 'staging/2', sqlBytes: 8, downloadedBytes: 8, parts: 2, objects: { registered: 3, staged: 3 } }, stagedSchema: { sha256: 'a'.repeat(64), bytes: 10 } });
  const response = await handleRecoveryExportStatus({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  const body = await response.json() as Record<string, unknown>;
  // A complete staging is still not a recoverable artifact: only a materialized and verified one is.
  expect([body.stage, body.recoverable]).toEqual(['complete', false]);
  expect(String(body.usable)).toContain('a complete staging is not yet one');
  env.sqlite.close();
});

const holds = (env: ReturnType<typeof sqliteEnv>) => env.sqlite.query('SELECT token, released_at, release_reason FROM recovery_holds ORDER BY acquired_at, token').all() as Array<{ token: string; released_at: number | null; release_reason: string | null }>;

it('opens a recovery hold before the export is admitted, and the attempt carries it', async () => {
  const env = sqliteEnv();
  const held = producer();
  const response = await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  expect(response.status).toBe(200);
  const [open] = holds(env);
  expect(open).toMatchObject({ released_at: null });
  expect(held.seen.map((admission) => admission.holdToken)).toEqual([open!.token]);
  // A second admission while that attempt advances opens no second hold and admits nothing.
  const again = await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  expect(((await again.json()) as { stage: string }).stage).toBe('export');
  expect([holds(env).length, held.seen.length]).toEqual([1, 1]);
  env.sqlite.close();
});

it('releases a hold only on an authoritative answer: kept while its attempt advances or the producer cannot answer, released once it rests', async () => {
  const env = sqliteEnv();
  const held = producer();
  await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  const token = holds(env)[0]!.token;
  const serverEnv = (recovery: unknown) => ({ ...env.serverEnv, recovery }) as never;

  expect(await recoveryHoldRelease(serverEnv(held.port), 2_000)).toBe(0);
  expect(await recoveryHoldRelease(serverEnv({ ...held.port, settleHold: async () => { throw new Error('unreachable'); } }), 3_000)).toBe(0);
  expect(await recoveryHoldRelease(serverEnv(undefined), 4_000)).toBe(0);
  expect(holds(env)).toEqual([{ token, released_at: null, release_reason: null }]);

  held.carried.set(token, { id: 1, stage: 'complete' });
  expect(await recoveryHoldRelease(serverEnv(held.port), 5_000)).toBe(1);
  expect(holds(env)).toEqual([{ token, released_at: 5_000, release_reason: 'attempt 1 complete' }]);
  expect(await recoveryHoldRelease(serverEnv(held.port), 6_000)).toBe(0);
  env.sqlite.close();
});

it('retires a hold whose admission never landed, and refuses that token if the admission arrives after', async () => {
  const env = sqliteEnv();
  const held = producer();
  const lost = { ...held.port, admit: async () => { throw new Error('the admission answer was lost'); } };
  const unanswered = await handleStartRecoveryExport({ ...env.serverEnv, recovery: lost } as never, OWNER);
  expect([unanswered.status, ((await unanswered.json()) as { error: string }).error]).toEqual([503, 'recovery_admission_unanswered']);
  const token = holds(env)[0]!.token;
  expect(await recoveryHoldRelease({ ...env.serverEnv, recovery: held.port } as never, 2_000)).toBe(1);
  expect(holds(env)).toEqual([{ token, released_at: 2_000, release_reason: 'retired' }]);
  const late = await held.port.admit({ holdToken: token } as RecoveryAdmission);
  expect(late.holdRetired).toBe(true);
  expect(held.seen).toEqual([]);
  env.sqlite.close();
});

it('keeps every release a deletion decides while the hold is open, and releases them once the hold settles', async () => {
  const env = sqliteEnv();
  const held = producer();
  const key = 'a'.repeat(64);
  registerBlob(env.sqlite, { projectId: 'proj_1', key, size: 1 });
  await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  expect(await releaseBlobs(env.db, [{ projectId: 'proj_1', key }], 2_000)).toEqual({ released: 0, deferred: 1 });
  await drainObjectReleases(env.serverEnv, 3_000);
  expect(env.sqlite.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 1 });
  held.carried.set(holds(env)[0]!.token, { id: 1, stage: 'downloaded' });
  await recoveryHoldRelease({ ...env.serverEnv, recovery: held.port } as never, 4_000);
  await drainObjectReleases(env.serverEnv, 5_000);
  expect(env.sqlite.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
  env.sqlite.close();
});

it('records who started the attempt, and hands the producer nothing else about the Deployment', async () => {
  const env = sqliteEnv();
  const held = producer();
  expect((await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER)).status).toBe(200);
  expect(held.seen[0]!.startedBy).toBe('owner-1');
  expect(Object.keys(held.seen[0]!).sort()).toEqual(['captured', 'holdToken', 'schema', 'startedBy', 'tables']);
  env.sqlite.close();
});

it('opens no hold and admits nothing when the producer cannot record the configuration', async () => {
  const env = sqliteEnv();
  const held = producer();
  const unready = { ...held.port, admission: { ready: false, reason: 'this Deployment carries no recovery configuration' } as RecoveryAdmissionReadiness };
  const refused = await handleStartRecoveryExport({ ...env.serverEnv, recovery: unready } as never, OWNER);
  expect(refused.status).toBe(503);
  expect(await refused.json() as Record<string, unknown>).toEqual({ error: 'recovery_configuration_unavailable', message: 'this Deployment carries no recovery configuration' });
  expect([holds(env), held.seen]).toEqual([[], []]);
  // A status read still answers.
  expect((await handleRecoveryExportStatus({ ...env.serverEnv, recovery: unready } as never, OWNER)).status).toBe(200);
  env.sqlite.close();
});

it('still answers an attempt already running and still settles its hold when the configuration is unavailable', async () => {
  const env = sqliteEnv();
  const held = producer();
  await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  const token = holds(env)[0]!.token;
  const unready = { ...held.port, admission: { ready: false, reason: 'stale configuration' } as RecoveryAdmissionReadiness };
  // While the attempt advances, an admission answers its progress and opens no second hold.
  const running = await handleStartRecoveryExport({ ...env.serverEnv, recovery: unready } as never, OWNER);
  expect([running.status, ((await running.json()) as { stage: string }).stage]).toEqual([200, 'export']);
  expect([holds(env).length, held.seen.length]).toEqual([1, 1]);
  // Once it rests, the admission settles and releases that hold, then refuses without opening another.
  held.carried.set(token, { id: 1, stage: 'complete' });
  const after = await handleStartRecoveryExport({ ...env.serverEnv, recovery: unready } as never, { ...OWNER as object, now: 7_000 } as never);
  expect(after.status).toBe(503);
  expect(holds(env)).toEqual([{ token, released_at: 7_000, release_reason: 'attempt 1 complete' }]);
  expect(await recoveryHoldRelease({ ...env.serverEnv, recovery: unready } as never, 8_000)).toBe(0);
  env.sqlite.close();
});

it('reads no Cloudflare binding in the owner route: the platform adapter decides readiness', () => {
  const source = require('node:fs').readFileSync(require.resolve('@myco-server-worker/api/recovery.js'), 'utf8') as string;
  expect(source).not.toMatch(/MYCO_[A-Z_]+|RECOVERY_EXPORT_TOKEN|bindings\.|CloudflareBindings/);
});

it('answers settlement from the attempt stage: advancing is open, resting is closed, none is retired', () => {
  for (const stage of ['export', 'download', 'inventory', 'copy'] as const) expect(settlementOf({ id: 1, stage }).state).toBe('open');
  for (const stage of ['downloaded', 'complete', 'unconfirmed', 'failed'] as const) expect(settlementOf({ id: 1, stage }).state).toBe('closed');
  expect(settlementOf(null)).toEqual({ state: 'retired' });
});
