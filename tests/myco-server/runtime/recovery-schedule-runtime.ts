/**
 * Runtime proof for automatic recovery, on real workerd.
 *
 * `wrangler dev --local` runs the product's own `DeploymentClock` and `RecoveryProducer` Durable Objects over a
 * local D1 and R2, so the wake, the job registry, the settings read, the hold and the producer are all the real
 * ones. What this proves cannot be proven in process: a clock wake admitting one attempt end to end, a second
 * wake in the same window admitting nothing, and the status a dashboard reads coming from that same state.
 *
 * Every process it starts is stopped by its exact PID, and the run refuses if any is left behind.
 *
 * Usage: bun tests/myco-server/runtime/recovery-schedule-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recovery-schedule-runtime-'));
const STATE = path.join(RUN, 'state');
const EVIDENCE = process.env.MYCO_RECOVERY_SCHEDULE_EVIDENCE ?? path.join(RUN, 'result.json');
const NAME = 'myco-recovery-schedule-runtime';
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

/**
 * A test entry around the product's own clock, producer object, environment mapping and schedule owner.
 *
 * The provider's export API is a loopback stand-in, so an admitted attempt advances without a real account: the
 * point here is the admission the clock makes, not the export the producer performs.
 */
const entry = (src: string) => `
import { DeploymentClock } from '${src}/platform/cloudflare/deployment-clock.ts';
import { RecoveryProducer } from '${src}/platform/cloudflare/recovery-producer-object.ts';
import { serverEnvFromBindings } from '${src}/platform/cloudflare/env.ts';
import { recoveryScheduleOf } from '${src}/core/recovery-schedule.ts';
export { DeploymentClock, RecoveryProducer };
const json = (value) => Response.json(value);
const answered = async (work) => { try { return { value: await work() }; } catch (error) { return { raised: String(error).slice(0, 300) }; } };
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const server = serverEnvFromBindings(env);
    const q = (name) => url.searchParams.get(name);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/interval') {
      if (q('hours') === null) {
        await env.MYCO_DB.prepare("DELETE FROM deployment_settings WHERE leaf = 'backup.auto_interval_hours'").run();
        return json({ interval: null });
      }
      await env.MYCO_DB.prepare("INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('backup.auto_interval_hours', ?, ?, 'mem_runtime')")
        .bind(JSON.stringify(Number(q('hours'))), Date.now()).run();
      return json({ interval: Number(q('hours')) });
    }
    if (url.pathname === '/schedule') return json(await answered(() => recoveryScheduleOf(server, Number(q('now') ?? Date.now()))));
    if (url.pathname === '/holds') return json((await env.MYCO_DB.prepare('SELECT token, holder, released_at, release_reason FROM recovery_holds ORDER BY acquired_at, token').all()).results);
    if (url.pathname === '/status') return json(await answered(() => server.recovery.status()));
    if (url.pathname === '/wake') {
      await env.MYCO_DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_request_at', ?)").bind(String(Date.now())).run();
      const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
      return json(await answered(async () => {
        const woke = await clock.wake();
        return {
          ticked: woke.ticked,
          state: woke.ticked ? woke.report.state : null,
          jobs: woke.ticked ? woke.report.jobs.filter((job) => job.name === 'recovery-export-schedule') : null,
        };
      }));
    }
    return new Response('not found', { status: 404 });
  },
};
`;

/**
 * A loopback stand-in for the provider's export API.
 *
 * Admission needs an export target to record; this run is about the admission the clock makes, so the stand-in
 * answers a poll that is still running and nothing here drives an export to completion.
 */
function stubProvider(port: number) {
  const state = { polls: 0 };
  const server = Bun.serve({
    port, hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/export')) {
        state.polls += 1;
        return Response.json({ success: true, result: { status: 'active', at_bookmark: `b${state.polls}` } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { state, stop: () => { server.stop(true); } };
}

function writeConfig(apiPort: number): string {
  const dir = path.join(RUN, 'current');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'entry.ts'), entry(path.join(ROOT, 'packages/myco-server/src')));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), [
    `name = "${NAME}"`, 'main = "entry.ts"', 'compatibility_date = "2026-08-01"', '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[durable_objects.bindings]]', 'name = "RECOVERY"', 'class_name = "RecoveryProducer"', '',
    '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = [ "DeploymentClock", "RecoveryProducer" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', `database_name = "${NAME}"`,
    'database_id = "00000000-0000-4000-8000-000000001318"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', `bucket_name = "${NAME}-blobs"`, '',
    '[[r2_buckets]]', 'binding = "RECOVERY_BUCKET"', `bucket_name = "${NAME}-recovery"`, '',
    '[vars]', 'CLOCK_MODE = "manual"', 'HARNESS_LAUNCH_MODE = "record"',
    'MYCO_RECOVERY_ACCOUNT_ID = "runtime-account"', 'MYCO_RECOVERY_DATABASE_ID = "runtime-database"',
    // The rendered configuration a deployed Worker carries, as a TOML literal string so its JSON needs no
    // escaping. Admission is refused without one, which this proof exercises before it is set.
    `MYCO_RECOVERY_API_ORIGIN = "http://127.0.0.1:${apiPort}"`,
    // The credential the producer object holds, and which nothing outside it ever reads. Disposable here.
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
const call = async (route: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(120_000) })).json();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
const scheduleJob = (woke: any): { name: string; changed: number; failed: string | null } | null => (woke.value?.jobs ?? [])[0] ?? null;

/**
 * What one wake admitted: the job's own count, or `not-ticked` where the clock declined to tick at all.
 *
 * The clock has its own floor, so a wake moments after another may do nothing. Either answer is an admission of
 * nothing, and the state checks below hold whichever it was.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
const admitted = (woke: any): number | 'not-ticked' => {
  if (woke.value?.ticked !== true) return 'not-ticked';
  const job = scheduleJob(woke);
  if (job === null) return 'not-ticked';
  if (job.failed !== null) throw new Error(`the schedule job failed: ${job.failed}`);
  return job.changed;
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

  // Off by default: a wake changes nothing, and the schedule says why in as many words.
  const off = await call('/schedule');
  check('with no interval set, nothing is configured and nothing is due', [off.value.supported, off.value.configured, off.value.due], [true, false, false]);
  note('what it says while off', off.value.idleBecause);
  const idle = await call('/wake');
  check('a clock wake admits nothing while it is off', admitted(idle), 0);
  check('and no hold was opened', (await call('/holds')).length, 0);

  // Set the interval: the first wake admits exactly one attempt, through the real producer object.
  check('the interval is stored as the owner set it', (await call('/interval?hours=6')).interval, 6);
  const due = await call('/schedule');
  check('an interval with no attempt yet is due immediately', [due.value.configured, due.value.due, due.value.intervalHours], [true, true, 6]);

  const first = await call('/wake');
  check('the first clock wake admits one attempt', admitted(first), 1);
  const holds = await call('/holds');
  check('it opened exactly one producer hold, still open', holds.map((row: { holder: string; released_at: number | null }) => [row.holder, row.released_at]), [['producer', null]]);
  const status = await call('/status');
  note('the attempt the producer holds', { attempt: status.value?.attempt, stage: status.value?.stage, startedAt: status.value?.startedAt !== null });
  check('the producer records an attempt with its own start', [status.value?.attempt, typeof status.value?.startedAt], [1, 'number']);

  // A duplicate wake in the same window: the attempt already holds the hold, so nothing new is admitted.
  const second = await call('/wake');
  note('what the second wake moments later did', second.value);
  check('a second wake moments later admits nothing', admitted(second) === 0 || admitted(second) === 'not-ticked', true);
  check('and there is still exactly one hold', (await call('/holds')).length, 1);

  const during = await call('/schedule');
  check('the schedule reports the advancing attempt rather than a due one', [during.value.due, during.value.dueAt, during.value.latest.attempt], [false, null, 1]);
  note('what it says while an attempt advances', during.value.idleBecause);
  check('and it never calls the staging recoverable', JSON.stringify(during.value.available).includes('recoverable'), false);

  // Far in the future, the attempt still holds the hold: an advancing attempt is never overtaken by the clock.
  const later = await call('/schedule?now=' + String(Date.now() + 72 * 60 * 60 * 1000));
  check('a much later reading still refuses to overtake it', later.value.due, false);
  const third = await call('/wake');
  check('and a wake then still admits nothing', admitted(third) === 0 || admitted(third) === 'not-ticked', true);
  check('one attempt, one hold, after three wakes', [(await call('/status')).value.attempt, (await call('/holds')).length], [1, 1]);

  // Turning it off stops the schedule, whatever state the attempt is in.
  check('the interval can be cleared', (await call('/interval')).interval, null);
  const cleared = await call('/schedule');
  check('cleared, nothing is configured or due', [cleared.value.configured, cleared.value.due], [false, false]);
  const cleared_wake = await call('/wake');
  check('a wake after clearing admits nothing', admitted(cleared_wake) === 0 || admitted(cleared_wake) === 'not-ticked', true);
} catch (error) {
  failure = error;
  console.log(`FAILED: ${String(error).slice(0, 600)}`);
} finally {
  if (worker !== null) await stop(worker);
  provider.stop();
}

const leftovers = owned.filter(({ pid }) => alive(pid));
const passed = checks.filter((entry) => entry.ok === true).length;
fs.writeFileSync(EVIDENCE, JSON.stringify({
  at: new Date().toISOString(), run: RUN, passed, total: checks.filter((entry) => 'check' in entry).length,
  failure: failure === null ? null : String(failure).slice(0, 600), owned, leftovers: leftovers.length, checks,
}, null, 2));
console.log(`${failure === null && leftovers.length === 0 ? 'passed' : 'FAILED'}: ${passed} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
process.exitCode = failure === null && leftovers.length === 0 ? 0 : 1;
