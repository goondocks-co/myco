import { expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { BUNDLED_WORKER } from '@myco/worker-bundle.generated.js';
import type { RecoveryProducerStatus } from '@myco-server-worker/core/recovery-producer.js';
import type { RecoverySchedule } from '@myco-server-worker/core/recovery-schedule.js';
import type { TelemetryEvent } from '@myco-server-worker/telemetry.js';

async function deployment(options: { credential?: boolean; failManifest?: boolean; bundled?: boolean } = {}) {
  const observer = `${import.meta.dir}/helpers/recovery-alarm-observer.ts`;
  const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/recovery-alarm-entry.ts`], format: 'esm', target: 'browser', external: ['cloudflare:workers', './product.js'],
    plugins: [{ name: 'recovery-telemetry', setup(build) {
      build.onResolve({ filter: /^\.\/product\.js$/ }, () => ({ path: './product.js', external: true }));
      build.onResolve({ filter: /(?:^|\/)telemetry\.js$/ }, args => args.importer === observer ? undefined : { path: observer });
      if (options.bundled) build.onLoad({ filter: /recovery-alarm-entry\.ts$/ }, args => ({ loader: 'ts', contents: readFileSync(args.path, 'utf8')
        .replace("import worker from '@myco-server-worker/index.js';", "import worker from './product.js';")
        .replace("import { DeploymentClock as ProductClock, clockStub }", "import { DeploymentClock as ProductClock } from './product.js';\nimport { clockStub }")
        .replace("from '@myco-server-worker/platform/cloudflare/recovery-producer-object.js'", "from './product.js'"),
      }));
    } }],
  });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const provider = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ success: true, result: { status: 'active', at_bookmark: 'b1' } }) });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: 'worker.js', contents: await bundle.outputs[0]!.text() },
      ...(options.bundled ? [{ type: 'ESModule' as const, path: 'product.js', contents: Buffer.from(BUNDLED_WORKER, 'base64').toString('utf8') }] : [])],
    compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['MYCO_DB'], r2Buckets: ['BUCKET', 'RECOVERY_BUCKET'],
    durableObjects: { CLOCK: { className: 'DeploymentClock', useSQLite: true }, RECOVERY: { className: 'RecoveryProducer', useSQLite: true } },
    bindings: {
      HARNESS_LAUNCH_MODE: 'record', MYCO_RECOVERY_ACCOUNT_ID: 'runtime-account', MYCO_RECOVERY_DATABASE_ID: 'runtime-database',
      RECOVERY_EXPORT_TOKEN: 'local-fake-token', MYCO_RECOVERY_API_ORIGIN: `http://127.0.0.1:${provider.port}`,
      MYCO_FLEET: '12', MYCO_ORIGIN: 'https://runtime.invalid', TEST_FAIL_MANIFEST: options.failManifest ?? false,
      MYCO_RECOVERY_CONFIGURATION: JSON.stringify({ accountId: 'runtime-account', databaseId: 'runtime-database', databaseName: 'runtime-db', workerName: 'runtime-worker',
        bucketName: 'runtime-blobs', recoveryBucketName: 'runtime-recovery', vectorIndexName: 'runtime-vectors', wrapKeySecretName: 'runtime-wrap', fleet: 12, url: 'https://runtime.invalid' }),
      ...(options.credential === false ? { RECOVERY_EXPORT_TOKEN: '' } : {}),
    },
  }));
  try {
    const db = await mf.getD1Database('MYCO_DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('backup.auto_interval_hours', '6', ?, 'test')").bind(Date.now()).run();
    const read = async (now = Date.now()) => (await (await mf.dispatchFetch(`http://local/test/status?now=${now}`)).json()) as {
      delivered: number; nextWakeAt: number | null; status: RecoveryProducerStatus; schedule: RecoverySchedule; events: TelemetryEvent[]; writes: string[];
    };
    let delivered = 0;
    const alarm = async () => {
      await (await mf.dispatchFetch('http://local/test/arm')).body?.cancel();
      const deadline = Date.now() + 20_000;
      let observed = await read();
      while (observed.delivered <= delivered && Date.now() < deadline) { await Bun.sleep(25); observed = await read(); }
      expect(observed.delivered).toBe(++delivered);
      return observed;
    };
    const bucket = await mf.getR2Bucket('RECOVERY_BUCKET');
    return { db, bucket, read, alarm, close: async () => { await mf.dispose(); provider.stop(true); } };
  } catch (error) { await mf.dispose(); provider.stop(true); throw error; }
}

for (const bundled of [false, true]) it(`workerd ${bundled ? 'deployable bundle' : 'source'}: a scheduled alarm records attempt 1 and advances its export`, async () => {
  const d = await deployment({ bundled });
  try {
    const observed = await d.alarm();
    expect(observed.status.attempt).toBe(1);
    expect(observed.status.stage).toBe('export');
    expect(observed.nextWakeAt).toBeGreaterThan(observed.status.startedAt!);
    const next = await d.alarm();
    expect(next.status.attempt).toBe(1);
    expect(next.status.export!.polls).toBeGreaterThan(0);
  } finally { await d.close(); }
}, 60_000);

it('workerd: a missing export credential reports unavailable and repeated alarms open no holds or staging', async () => {
  const d = await deployment({ credential: false });
  try {
    for (let wake = 0; wake < 2; wake++) {
      const observed = await d.alarm();
      expect(observed.schedule).toMatchObject({ ready: false, due: false, idleCode: 'backup_export_credential_missing' });
      expect(observed.schedule.idleBecause).toContain('export credential');
      expect(observed.writes).toEqual([]);
      expect(observed.events.filter(event => event.kind === 'recovery_admission_unanswered')).toEqual([]);
    }
    expect((await d.db.prepare('SELECT token FROM recovery_holds').all()).results).toEqual([]);
    expect((await d.bucket.list()).objects).toEqual([]);
  } finally { await d.close(); }
}, 60_000);

it('workerd: a failed staging publication reports a safe reason, releases its hold and waits its configured interval', async () => {
  const d = await deployment({ failManifest: true });
  try {
    const first = await d.alarm();
    expect(first.nextWakeAt).toBeGreaterThan(first.status.startedAt!);
    expect(first.events.find(event => event.kind === 'recovery_admission_unanswered')).toEqual({
      kind: 'recovery_admission_unanswered', error_class: 'unknown', error_reason: 'TypeError:unknown',
    });
    expect(first.status).toMatchObject({ attempt: 1, stage: 'failed', staged: null });
    expect((await d.bucket.list()).objects).toEqual([]);
    expect((await d.db.prepare('SELECT token FROM recovery_holds WHERE released_at IS NULL').all()).results).toEqual([]);
    const count = first.writes.length;
    expect(count).toBe(2);
    const next = await d.alarm();
    expect(next.status.attempt).toBe(1);
    expect(next.writes).toHaveLength(count);
    const before = await d.read(first.status.startedAt! + 60_000);
    expect(before.schedule.due).toBe(false);
    expect((await d.read(first.status.startedAt! + 6 * 60 * 60 * 1000)).schedule.due).toBe(true);
    const telemetry = JSON.stringify(first.events);
    expect(telemetry).not.toContain('secret.invalid');
    expect(telemetry).not.toContain('local-fake-token');
  } finally { await d.close(); }
}, 60_000);
