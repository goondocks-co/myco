/**
 * Runtime proof for hosted staging retention, on real workerd.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` and `RecoveryProducer` Durable Objects over a
 * local D1 and R2, so the registered job, the settings read, the hold table and the producer are the real ones.
 * What this proves cannot be proven in process: staged files that actually leave an R2 bucket, in the order the
 * producer deletes them, with the surviving staging's bytes still readable afterwards.
 *
 * Each attempt's capture is this harness's own three-table schema and its provider is a loopback stand-in, as in
 * the producer runtime: what is under test is the release of staged payloads, not the export that wrote them.
 * The D1 beside it is the real one, and every hold, setting and job here is read and run through it.
 *
 * Every process it starts is stopped by its exact PID, and the run refuses if any is left behind.
 *
 * Usage: bun tests/myco-server/runtime/staging-retention-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-staging-retention-runtime-'));
const STATE = path.join(RUN, 'state');
const EVIDENCE = process.env.MYCO_STAGING_RETENTION_EVIDENCE ?? path.join(RUN, 'result.json');
const NAME = 'myco-staging-retention-runtime';
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 220)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const freePort = () => new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); });
});
const descendants = (pid: number): number[] => {
  const found = Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim();
  return found === '' ? [] : found.split('\n').map(Number).flatMap((child) => [child, ...descendants(child)]);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function stop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const tree = [proc.pid, ...descendants(proc.pid)];
  for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/** The objects each export's own rows name, and the bytes the Deployment's store holds for them. */
const BLOB_BODY = new Uint8Array([0, 1, 127, 128, 255]);
const BACKUP_BODY = new TextEncoder().encode('{"format":"myco-backup/1"}\n');
const BLOB_DIGEST = new Bun.CryptoHasher('sha256').update(BLOB_BODY).digest('hex');
const BLOB_GENERATION = '5f1e2d3c-4b5a-4968-8776-655443322110';
const BACKUP_KEY = 'backups/lineage__1__bk_retention.jsonl';
/** Where the Deployment's store holds each object, which is what the copy reads. */
const SOURCE_OBJECTS: Record<string, Uint8Array> = { [`proj_1/${BLOB_DIGEST}~${BLOB_GENERATION}`]: BLOB_BODY, [BACKUP_KEY]: BACKUP_BODY };
/** What a staging holds: the export, its schema, its manifest, and one file per object its rows name. */
const STAGING_FILES = 5;

const BLOBS_DDL = 'CREATE TABLE blobs (project_id TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, generation TEXT, PRIMARY KEY (project_id, key))';
const BACKUPS_DDL = 'CREATE TABLE backups (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, counts_json TEXT NOT NULL, schema_version INTEGER NOT NULL, producer TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, sha256 TEXT)';

/** The export's bytes: definitions the capture agrees with, and the rows naming the objects each staging copies. */
const EXPORT = new TextEncoder().encode([
  'CREATE TABLE sessions (id TEXT);',
  `${BLOBS_DDL};`,
  `${BACKUPS_DDL};`,
  `INSERT INTO blobs VALUES('proj_1','${BLOB_DIGEST}',${BLOB_BODY.byteLength},'${BLOB_GENERATION}');`,
  `INSERT INTO backups VALUES('bk_1','${BACKUP_KEY}',1789590000000,${BACKUP_BODY.byteLength},'{}',41,'myco',0,NULL);`,
  '',
].join('\n'));
const EXPORT_DIGEST = new Bun.CryptoHasher('sha256').update(EXPORT).digest('hex');

/** A loopback stand-in for the provider: one poll, then a signed download of the export above. */
function stubProvider(port: number) {
  const state = { polls: 0, ranges: 0 };
  const server = Bun.serve({
    port, hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/export')) {
        state.polls += 1;
        return Response.json({
          success: true,
          result: { status: 'complete', at_bookmark: 'b-final', result: { signed_url: `http://127.0.0.1:${port}/signed/export.sql` } },
        });
      }
      if (url.pathname === '/signed/export.sql') {
        state.ranges += 1;
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
        if (range === null) return new Response(EXPORT, { status: 200 });
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), EXPORT.byteLength - 1);
        return new Response(EXPORT.slice(start, end + 1), {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${EXPORT.byteLength}`, etag: 'w/"export"' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { state, stop: () => { server.stop(true); } };
}

/**
 * A test entry around the product's own clock, producer object, environment mapping and retention owners.
 *
 * `RefusedDeletes` is the shipped producer class over a bucket whose `delete` refuses and whose every other
 * method is the real binding's, so the refusal path runs the same code the Deployment does.
 */
const entry = (src: string) => `
import { DeploymentClock } from '${src}/platform/cloudflare/deployment-clock.ts';
import { RecoveryProducer } from '${src}/platform/cloudflare/recovery-producer-object.ts';
import { serverEnvFromBindings } from '${src}/platform/cloudflare/env.ts';
import { recoveryScheduleOf } from '${src}/core/recovery-schedule.ts';
import { stagingPrunePolicy, stagingPruneDue, KEEP_STAGINGS_SETTING } from '${src}/core/staging-retention.ts';
import { capturedDefinitions } from '${src}/core/recovery-producer.ts';
import { recoveryAdmissionWire } from '${src}/platform/cloudflare/recovery-export.ts';
import { acquireRecoveryHold, releaseRecoveryHold } from '${src}/core/object-release.ts';

const refusingBucket = (bucket) => ({
  put: (...a) => bucket.put(...a),
  get: (...a) => bucket.get(...a),
  head: (...a) => bucket.head(...a),
  list: (...a) => bucket.list(...a),
  createMultipartUpload: (...a) => bucket.createMultipartUpload(...a),
  resumeMultipartUpload: (...a) => bucket.resumeMultipartUpload(...a),
  delete: async () => { throw new Error('the store refused this delete'); },
});
export class RefusedDeletes extends RecoveryProducer {
  constructor(ctx, env) { super(ctx, { ...env, RECOVERY_BUCKET: refusingBucket(env.RECOVERY_BUCKET) }); }
}
export { DeploymentClock, RecoveryProducer };

const SCHEMA = [
  { type: 'table', name: 'sessions', sql: 'CREATE TABLE sessions (id TEXT)', storage: 'table' },
  { type: 'table', name: 'blobs', sql: ${'`'}${BLOBS_DDL}${'`'}, storage: 'table' },
  { type: 'table', name: 'backups', sql: ${'`'}${BACKUPS_DDL}${'`'}, storage: 'table' },
];
const admission = (holdToken, env) => recoveryAdmissionWire({
  holdToken, tables: ['sessions', 'blobs', 'backups'], schema: JSON.stringify(SCHEMA),
  captured: capturedDefinitions(SCHEMA), startedBy: 'schedule',
}, env);
const json = (value) => Response.json(value);
const answered = async (work) => { try { return { value: await work() }; } catch (error) { return { raised: String(error).slice(0, 300) }; } };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = (name) => url.searchParams.get(name);
    const server = serverEnvFromBindings(env);
    const object = (which) => (which === 'refusing'
      ? env.REFUSING.get(env.REFUSING.idFromName('recovery'))
      : env.RECOVERY.get(env.RECOVERY.idFromName('recovery')));
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/keep') {
      if (q('n') === null) {
        await env.MYCO_DB.prepare('DELETE FROM deployment_settings WHERE leaf = ?').bind(KEEP_STAGINGS_SETTING).run();
        return json({ keep: null });
      }
      await env.MYCO_DB.prepare('INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, \\'mem_runtime\\')')
        .bind(KEEP_STAGINGS_SETTING, JSON.stringify(Number(q('n'))), Date.now()).run();
      return json(await answered(() => stagingPrunePolicy(server)));
    }
    if (url.pathname === '/policy') return json(await answered(() => stagingPrunePolicy(server)));
    if (url.pathname === '/due') return json(await answered(() => stagingPruneDue(server)));
    if (url.pathname === '/hold') return json({ opened: await acquireRecoveryHold(env.MYCO_DB, q('token'), Date.now()) });
    if (url.pathname === '/release') return json({ released: await releaseRecoveryHold(env.MYCO_DB, q('token'), Date.now(), 'retired') });
    if (url.pathname === '/holds') return json((await env.MYCO_DB.prepare('SELECT token, holder, released_at IS NOT NULL AS released FROM recovery_holds ORDER BY acquired_at, token').all()).results);
    if (url.pathname === '/seed') { await env.BUCKET.put(q('key'), request.body); return json({ seeded: q('key') }); }
    if (url.pathname === '/admit') return json(await answered(() => object(q('on')).admit(admission(q('hold'), env))));
    if (url.pathname === '/drive') {
      return json(await answered(async () => {
        const producer = object(q('on'));
        let status = await producer.admit(admission(q('hold'), env));
        for (let step = 0; step < 60 && status.stage !== 'complete' && status.stage !== 'failed'; step += 1) {
          await producer.continue();
          status = await producer.status();
        }
        return status;
      }));
    }
    if (url.pathname === '/prune') {
      return json(await answered(async () => {
        const policy = await stagingPrunePolicy(server);
        return { policy, report: await object(q('on')).pruneStagings({ ...policy, budget: Number(q('budget')) }) };
      }));
    }
    if (url.pathname === '/pending') {
      return json(await answered(async () => object(q('on')).pendingStagingPrunes(await stagingPrunePolicy(server))));
    }
    if (url.pathname === '/status') return json(await answered(() => object(q('on')).status()));
    if (url.pathname === '/schedule') return json(await answered(() => recoveryScheduleOf(server, Date.now())));
    if (url.pathname === '/files') {
      const listed = await env.RECOVERY_BUCKET.list({ prefix: q('prefix') ?? '', limit: 1000 });
      return json({ keys: listed.objects.map((entry) => entry.key).sort() });
    }
    if (url.pathname === '/read') {
      const held = await env.RECOVERY_BUCKET.get(q('key'));
      if (held === null) return json({ file: null });
      const bytes = new Uint8Array(await held.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return json({ bytes: bytes.byteLength, sha256: [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('') });
    }
    if (url.pathname === '/wake') {
      if (q('stamp') === 'no') await env.MYCO_DB.prepare("DELETE FROM schema_meta WHERE key = 'last_request_at'").run();
      else await env.MYCO_DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_request_at', ?)").bind(String(Date.now())).run();
      const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
      return json(await answered(async () => {
        const woke = await clock.wake();
        return {
          ticked: woke.ticked,
          state: woke.ticked ? woke.report.state : null,
          heldBy: woke.ticked ? woke.report.heldBy : null,
          jobs: woke.ticked ? woke.report.jobs.filter((job) => job.name === 'recovery-staging-retention') : null,
        };
      }));
    }
    return new Response('not found', { status: 404 });
  },
};
`;

function writeConfig(apiPort: number): string {
  const dir = path.join(RUN, 'current');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.ts'), entry(path.join(ROOT, 'packages/myco-server/src')));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), [
    `name = "${NAME}"`, 'main = "entry.ts"', 'compatibility_date = "2026-08-01"', '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[durable_objects.bindings]]', 'name = "RECOVERY"', 'class_name = "RecoveryProducer"', '',
    '[[durable_objects.bindings]]', 'name = "REFUSING"', 'class_name = "RefusedDeletes"', '',
    '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = [ "DeploymentClock", "RecoveryProducer", "RefusedDeletes" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', `database_name = "${NAME}"`,
    'database_id = "00000000-0000-4000-8000-000000001319"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', `bucket_name = "${NAME}-blobs"`, '',
    '[[r2_buckets]]', 'binding = "RECOVERY_BUCKET"', `bucket_name = "${NAME}-recovery"`, '',
    '[vars]', 'CLOCK_MODE = "manual"', 'HARNESS_LAUNCH_MODE = "record"',
    'MYCO_RECOVERY_ACCOUNT_ID = "runtime-account"', 'MYCO_RECOVERY_DATABASE_ID = "runtime-database"',
    `MYCO_RECOVERY_API_ORIGIN = "http://127.0.0.1:${apiPort}"`,
    'RECOVERY_EXPORT_TOKEN = "runtime-export-token"',
    `MYCO_RECOVERY_CONFIGURATION = '${JSON.stringify({
      accountId: 'runtime-account', databaseId: 'runtime-database', databaseName: NAME, workerName: NAME,
      bucketName: `${NAME}-blobs`, recoveryBucketName: `${NAME}-recovery`,
      vectorIndexName: `${NAME}-vectors`, wrapKeySecretName: `${NAME}-wrap`,
    })}'`, '',
  ].join('\n'));
  return dir;
}

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;

async function start(dir: string): Promise<void> {
  port = await freePort();
  const inspector = await freePort();
  const log = fs.openSync(path.join(RUN, 'wrangler.log'), 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port),
    '--inspector-port', String(inspector), '--persist-to', STATE, '-c', path.join(dir, 'wrangler.toml')], {
    cwd: dir, stdin: 'ignore', stdout: log, stderr: log,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: 'wrangler dev', pid: worker.pid });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch { /* not serving yet */ }
    if (worker.exitCode !== null) throw new Error(`wrangler dev exited ${worker.exitCode}; see wrangler.log`);
    await Bun.sleep(250);
  }
  throw new Error('wrangler dev did not answer within 120s');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the harness reads its own Worker's JSON
const call = async (route: string, init?: RequestInit): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(180_000), ...init })).json();
const files = async (prefix: string): Promise<string[]> => (await call(`/files?prefix=${encodeURIComponent(prefix)}`)).keys;
/** The prefix of one attempt's staging, read from the status it answers. */
const drive = async (hold: string, on = 'recovery'): Promise<{ attempt: number; prefix: string }> => {
  const status = (await call(`/drive?hold=${hold}&on=${on}`)).value;
  if (status === undefined || status.stage !== 'complete') throw new Error(`${hold} did not complete: ${JSON.stringify(status).slice(0, 300)}`);
  return { attempt: status.attempt, prefix: status.staged.prefix };
};

let failure: unknown = null;
const apiPort = await freePort();
const provider = stubProvider(apiPort);
try {
  const dir = writeConfig(apiPort);
  const migrate = Bun.spawnSync([WRANGLER, 'd1', 'migrations', 'apply', NAME, '--local', '--persist-to', STATE, '-c', path.join(dir, 'wrangler.toml')],
    { cwd: dir, stdin: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, timeout: 300_000 });
  fs.writeFileSync(path.join(RUN, 'migrate.log'), `exit ${migrate.exitCode}\n${migrate.stdout}${migrate.stderr}`);
  if (migrate.exitCode !== 0) throw new Error('migrations failed; see migrate.log');
  await start(dir);

  for (const [key, body] of Object.entries(SOURCE_OBJECTS)) {
    await call(`/seed?key=${encodeURIComponent(key)}`, { method: 'PUT', body: body as unknown as BodyInit });
  }

  // Three complete stagings, each written by the real producer through its own admission and continuations.
  const staged = [await drive('hold-1'), await drive('hold-2'), await drive('hold-3')];
  note('the stagings this run wrote', staged);
  for (const one of staged) check(`attempt ${one.attempt} holds ${STAGING_FILES} files`, (await files(one.prefix)).length, STAGING_FILES);
  check('the newest staging is the one an owner is told about', (await call('/schedule')).value.available.attempt, staged[2].attempt);

  // Nothing is owed while the default keeps all three: two complete stagings kept, and the third is the newest.
  check('with three complete stagings and the default policy, one is owed', (await call('/pending?on=recovery')).value, 1);

  // The registered job on a clock wake, with the policy an owner set.
  check('the policy an owner sets is what the job reads', (await call('/keep?n=2')).value.keep, 2);
  const woke = await call('/wake');
  check('the registered retention job ran on the clock wake and released one staging',
    [woke.value.jobs?.length ?? 0, woke.value.jobs?.[0]?.changed ?? null, woke.value.jobs?.[0]?.failed ?? null], [1, 1, null]);
  check('the oldest staging has no file left in the bucket', await files(staged[0].prefix), []);
  check('the two the policy keeps are untouched',
    [(await files(staged[1].prefix)).length, (await files(staged[2].prefix)).length], [STAGING_FILES, STAGING_FILES]);

  // Surviving bytes, read back from the bucket: the newest staging's export still matches the staged digest.
  const survivor = await call(`/read?key=${encodeURIComponent(`${staged[2].prefix}/d1.sql`)}`);
  check('the surviving staging\'s export reads back with the bytes it was staged with',
    [survivor.bytes, survivor.sha256], [EXPORT.byteLength, EXPORT_DIGEST]);

  // The pruned attempt's tombstone: its token admits nothing, and its staging is reported as no longer there.
  const replay = (await call('/admit?hold=hold-1')).value;
  check('the released attempt\'s own hold token admits no second export',
    [replay.attempt, replay.stage, replay.staged, replay.stagingPruned ?? false, replay.recoverable],
    [staged[0].attempt, 'complete', null, true, false]);
  check('and no new staging was written for it', await files(staged[0].prefix), []);
  check('the newest staging is still what an owner is told about', (await call('/schedule')).value.available.attempt, staged[2].attempt);

  // Bounded batches: one file a pass is the tightest budget there is, and it still finishes the staging.
  check('tightening the policy makes the next staging owed', (await call('/keep?n=1')).value.keep, 1);
  const passes: Array<{ releasedFiles: number; releasedStagings: number; pending: number; refused: string | null }> = [];
  for (let pass = 0; pass < 9 && (passes[passes.length - 1]?.pending ?? 1) > 0; pass += 1) {
    passes.push((await call('/prune?budget=1')).value.report);
  }
  note('what each bounded pass released', passes);
  check('every pass released exactly its budget of one file, and no pass asked for a file twice',
    [passes.length, passes.every((one) => one.releasedFiles === 1)], [STAGING_FILES, true]);
  check('the passes together released the whole staging and nothing else',
    [passes.reduce((total, one) => total + one.releasedFiles, 0), passes.reduce((total, one) => total + one.releasedStagings, 0), passes[passes.length - 1].pending],
    [STAGING_FILES, 1, 0]);
  check('the staging those passes released is gone', await files(staged[1].prefix), []);
  check('and the last good staging is untouched and still readable',
    [(await files(staged[2].prefix)).length, (await call(`/read?key=${encodeURIComponent(`${staged[2].prefix}/d1.sql`)}`)).sha256],
    [STAGING_FILES, EXPORT_DIGEST]);

  // A hold this Deployment holds open protects its attempt's staging, whatever the policy says.
  const fourth = await drive('hold-4');
  check('a fourth attempt staged over the surviving one', (await files(fourth.prefix)).length, STAGING_FILES);
  check('the open hold is the one the policy protects', (await call('/hold?token=hold-3')).opened, true);
  check('and the policy the job reads carries it', (await call('/policy')).value.protect, ['hold-3']);
  const held = await call('/wake');
  check('the job releases nothing while that hold is open',
    [held.value.jobs?.[0]?.changed ?? null, (await files(staged[2].prefix)).length], [0, STAGING_FILES]);
  // The hold's own owner settles it, in the same wake and after retention has already passed on it.
  check('the Deployment\'s own hold-release job settled that hold against the producer',
    (await call('/holds')).find((row: { token: string; released: number }) => row.token === 'hold-3')?.released, 1);
  const after = await call('/wake');
  check('and the next wake releases that staging',
    [after.value.jobs?.[0]?.changed ?? null, await files(staged[2].prefix)], [1, []]);
  check('while the newest staging stands', (await files(fourth.prefix)).length, STAGING_FILES);

  // An inactive Deployment: nothing stamps activity, so only the owed cleanup itself keeps it out of deep sleep.
  const fifth = await drive('hold-5');
  check('a fifth attempt makes the fourth one owed', (await call('/pending')).value, 1);
  const inactive = await call('/wake?stamp=no');
  check('a Deployment nobody has touched is held at sleep by the cleanup it owes',
    [inactive.value.state, inactive.value.heldBy], ['sleep', 'recovery:prune']);
  check('and that wake released the staging the policy lets go of',
    [inactive.value.jobs?.[0]?.changed ?? null, await files(fourth.prefix)], [1, []]);
  check('while the newest staging is untouched and still readable',
    [(await files(fifth.prefix)).length, (await call(`/read?key=${encodeURIComponent(`${fifth.prefix}/d1.sql`)}`)).sha256],
    [STAGING_FILES, EXPORT_DIGEST]);
  const settled = await call('/wake?stamp=no');
  check('with nothing owed, nothing holds it out of deep sleep',
    [settled.value.state, (await call('/due')).value], ['deep_sleep', false]);

  // A store that refuses a delete: nothing is lost, and the pass carries a classifier rather than the store's text.
  const refused = await drive('refusing-1', 'refusing');
  const refusedSecond = await drive('refusing-2', 'refusing');
  check('two stagings on the producer whose store refuses deletes',
    [(await files(refused.prefix)).length, (await files(refusedSecond.prefix)).length], [STAGING_FILES, STAGING_FILES]);
  const report = (await call('/prune?on=refusing&budget=50')).value.report;
  check('the refused pass releases nothing and classifies the refusal',
    [report.releasedFiles, report.releasedStagings, report.refused, report.pending], [0, 0, 'unknown', 1]);
  check('and the store\'s own words travel nowhere with it',
    JSON.stringify(report).includes('the store refused this delete'), false);
  check('and every file of both stagings is still there',
    [(await files(refused.prefix)).length, (await files(refusedSecond.prefix)).length], [STAGING_FILES, STAGING_FILES]);

  note('the provider stand-in\'s own counts', provider.state);
} catch (error) {
  failure = error;
  console.log(`FAILED: ${String(error).slice(0, 800)}`);
} finally {
  if (worker !== null) await stop(worker);
  provider.stop();
}

const leftovers = owned.filter(({ pid }) => alive(pid));
const passed = checks.filter((entry) => entry.ok === true).length;
fs.writeFileSync(EVIDENCE, JSON.stringify({
  at: new Date().toISOString(), run: RUN, passed, total: checks.filter((entry) => 'check' in entry).length,
  failure: failure === null ? null : String(failure).slice(0, 800), owned, leftovers: leftovers.length, checks,
}, null, 2));
console.log(`${failure === null && leftovers.length === 0 ? 'passed' : 'FAILED'}: ${passed} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
process.exitCode = failure === null && leftovers.length === 0 ? 0 : 1;
