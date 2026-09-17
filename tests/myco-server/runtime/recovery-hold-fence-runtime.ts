/**
 * Runtime proof for the operator recovery hold, on real workerd and a real local D1.
 *
 * One persisted state — D1 migrated through step 43, the Durable Objects and two R2 buckets — is driven in turn by a
 * Worker built from this source and one built from the release before this slice, extracted from its own commit. What
 * it proves cannot be proven in process: the database refuses the release statement that release still runs, its tick
 * reports the failure and keeps going, its admission opens nothing, and its deletions defer. Then this release's Worker
 * settles its own producer hold, leaves the operator hold alone, and drains what the hold deferred once the operator
 * releases it.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/recovery-hold-fence-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-fence-runtime-'));
const EVIDENCE = process.env.MYCO_HOLD_FENCE_EVIDENCE ?? path.join(RUN, 'result.json');
const STATE = path.join(RUN, 'state');
/** The release whose Worker still runs while this one is rolled out. */
const PREVIOUS_COMMIT = process.env.MYCO_HOLD_FENCE_PREVIOUS ?? '2c39ce7b';
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);

async function stop(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const tree = descendants(proc.pid);
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await Promise.race([proc.exited, Bun.sleep(10_000)]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tree.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) break;
    await Bun.sleep(100);
  }
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** The release before this slice, extracted from its own commit, so its statements are the ones it really runs. */
function previousSource(commit: string): string {
  const root = path.join(RUN, `previous-${commit}`);
  if (fs.existsSync(path.join(root, 'packages/myco-server/src'))) return path.join(root, 'packages/myco-server/src');
  fs.mkdirSync(root, { recursive: true });
  const archive = Bun.spawnSync(['git', '-C', ROOT, 'archive', commit,
    'packages/myco-server/src', 'packages/myco-server/tsconfig.json', 'packages/myco-shared/src'], { stdin: 'ignore' });
  if (archive.exitCode !== 0) throw new Error(`git archive ${commit} failed`);
  const unpack = Bun.spawnSync(['tar', '-x', '-C', root], { stdin: archive.stdout });
  if (unpack.exitCode !== 0) throw new Error('unpacking the previous release failed');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  return path.join(root, 'packages/myco-server/src');
}

/** A test entry around the product's own clock, producer object, environment mapping and hold owner. */
const entry = (src: string, operator: boolean) => `
import { DeploymentClock } from '${src}/platform/cloudflare/deployment-clock.ts';
import { RecoveryProducer } from '${src}/platform/cloudflare/recovery-producer-object.ts';
import { serverEnvFromBindings } from '${src}/platform/cloudflare/env.ts';
import { openHoldForAdmission } from '${src}/core/recovery-hold.ts';
import { releaseBlobs, releaseRecoveryHold } from '${src}/core/object-release.ts';
${operator ? `import { acquireOperatorHold, settleOperatorHold, openOperatorHold } from '${src}/core/recovery-hold.ts';` : ''}
export { DeploymentClock, RecoveryProducer };
const json = (value) => Response.json(value);
const answered = async (work) => { try { return { value: await work() }; } catch (error) { return { raised: String(error).slice(0, 200) }; } };
const PROJECT = 'proj_1';
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const server = serverEnvFromBindings(env);
    const q = (name) => url.searchParams.get(name);
    if (url.pathname === '/health') return json({ ok: true, build: '${operator ? 'current' : 'previous'}' });
    if (url.pathname === '/holds') return json((await env.MYCO_DB.prepare('SELECT * FROM recovery_holds ORDER BY acquired_at, token').all()).results);
    if (url.pathname === '/version') return json(await env.MYCO_DB.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first());
    ${operator ? `
    if (url.pathname === '/operator-acquire') return json(await answered(() => acquireOperatorHold(server, q('token'), Number(q('now')))));
    if (url.pathname === '/operator-release') return json(await answered(() => settleOperatorHold(server, q('token'), Number(q('now')), q('reason'))));
    if (url.pathname === '/operator-open') return json(await answered(() => openOperatorHold(server)));` : ''}
    if (url.pathname === '/producer-release') return json(await answered(() => releaseRecoveryHold(server.db, q('token'), Date.now(), 'attempt 1 complete')));
    if (url.pathname === '/admission') return json(await answered(() => openHoldForAdmission(server, Date.now(), true)));
    if (url.pathname === '/register') {
      const generation = crypto.randomUUID();
      await env.BUCKET.put(PROJECT + '/' + q('key') + '~' + generation, 'registered bytes');
      await env.MYCO_DB.prepare("INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?, ?, 16, 'text/plain', 't', 1, ?)").bind(PROJECT, q('key'), generation).run();
      return json({ physical: PROJECT + '/' + q('key') + '~' + generation });
    }
    if (url.pathname === '/release') return json(await answered(() => releaseBlobs(server.db, [{ projectId: PROJECT, key: q('key') }], Date.now())));
    if (url.pathname === '/wake') {
      await env.MYCO_DB.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('last_request_at', ?)").bind(String(Date.now())).run();
      const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
      return json(await answered(async () => {
        const woke = await clock.wake();
        return { ticked: woke.ticked, jobs: woke.ticked ? woke.report.jobs.filter((job) => ['recovery-hold-release', 'object-release-drain'].includes(job.name)) : null };
      }));
    }
    if (url.pathname === '/state') return json({
      blobs: (await env.MYCO_DB.prepare('SELECT key FROM blobs ORDER BY key').all()).results.map((row) => row.key),
      journal: (await env.MYCO_DB.prepare('SELECT physical FROM object_releases').all()).results.length,
      candidates: (await env.MYCO_DB.prepare('SELECT key FROM blob_release_candidates').all()).results.length,
      objects: (await env.BUCKET.list({ prefix: PROJECT + '/' })).objects.length,
    });
    return new Response('not found', { status: 404 });
  },
};
`;

function writeConfig(which: 'current' | 'previous'): string {
  const dir = path.join(RUN, which);
  fs.mkdirSync(dir, { recursive: true });
  const src = which === 'current' ? path.join(ROOT, 'packages/myco-server/src') : previousSource(PREVIOUS_COMMIT);
  fs.writeFileSync(path.join(dir, 'entry.ts'), entry(src, which === 'current'));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), [
    'name = "myco-hold-fence-runtime"', 'main = "entry.ts"', 'compatibility_date = "2026-08-01"', '',
    '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
    '[[durable_objects.bindings]]', 'name = "RECOVERY"', 'class_name = "RecoveryProducer"', '',
    '[[migrations]]', 'tag = "v1"', 'new_sqlite_classes = [ "DeploymentClock", "RecoveryProducer" ]', '',
    '[[d1_databases]]', 'binding = "MYCO_DB"', 'database_name = "myco-hold-fence-runtime"',
    'database_id = "00000000-0000-4000-8000-000000001316"',
    `migrations_dir = "${path.join(ROOT, 'packages/myco-server/migrations')}"`, '',
    '[[r2_buckets]]', 'binding = "BUCKET"', 'bucket_name = "myco-hold-fence-runtime-blobs"', '',
    '[[r2_buckets]]', 'binding = "RECOVERY_BUCKET"', 'bucket_name = "myco-hold-fence-runtime-recovery"', '',
    '[vars]', 'CLOCK_MODE = "manual"', 'HARNESS_LAUNCH_MODE = "record"',
    'MYCO_RECOVERY_ACCOUNT_ID = "runtime-account"', 'MYCO_RECOVERY_DATABASE_ID = "runtime-database"', '',
  ].join('\n'));
  return dir;
}

let worker: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
async function start(which: 'current' | 'previous'): Promise<void> {
  const dir = writeConfig(which);
  port = await freePort();
  const inspector = await freePort();
  const log = fs.openSync(path.join(RUN, `wrangler-${which}.log`), 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', STATE, '-c', path.join(dir, 'wrangler.toml')], {
    cwd: dir, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: `wrangler dev ${which}`, pid: worker.pid });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (answer.ok) { check(`the ${which} Worker answers as its own build`, ((await answer.json()) as { build: string }).build, which); return; }
    } catch {}
    if (worker.exitCode !== null) throw new Error(`wrangler dev ${which} exited ${worker.exitCode}`);
    await Bun.sleep(250);
  }
  throw new Error(`wrangler dev ${which} did not answer within 120s`);
}
const halt = async () => { if (worker !== null) { await stop(worker); worker = null; } };
const call = async (route: string): Promise<any> => (await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(120_000) })).json();
const open = (holds: any[]) => holds.filter((h) => h.released_at === null).map((h) => `${h.holder}:${h.token}`).sort();
const job = (woke: any, name: string): { name: string; failed: string | null } | null => (woke.value?.jobs ?? []).find((j: any) => j.name === name) ?? null;

let failure: unknown = null;
try {
  writeConfig('current');
  const migrate = Bun.spawnSync([WRANGLER, 'd1', 'migrations', 'apply', 'myco-hold-fence-runtime', '--local', '--persist-to', STATE, '-c', path.join(RUN, 'current', 'wrangler.toml')],
    { cwd: path.join(RUN, 'current'), stdin: 'ignore', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }, timeout: 300_000 });
  fs.writeFileSync(path.join(RUN, 'migrate.log'), `exit ${migrate.exitCode}\n${migrate.stdout}${migrate.stderr}`);
  if (migrate.exitCode !== 0) throw new Error('migrations failed; see migrate.log');

  await start('current');
  check('the migrated schema step', (await call('/version')).value, '43');
  check('an operator backup opens its hold', (await call('/operator-acquire?token=op-1&now=10')).value, true);
  await call('/register?key=' + 'a'.repeat(64));
  check('a deletion while it is open defers', (await call('/release?key=' + 'a'.repeat(64))).value, { released: 0, deferred: 1 });
  await halt();

  // The release before this slice, on the same state.
  await start('previous');
  const previousWake = await call('/wake');
  check('the previous release still ticks', previousWake.value?.ticked, true);
  const previousHoldJob = job(previousWake, 'recovery-hold-release');
  check("its hold-release job fails rather than releasing an operator backup's hold", previousHoldJob !== null && previousHoldJob.failed !== null, true);
  const previousDrainJob = job(previousWake, 'object-release-drain');
  check('its drain job runs', previousDrainJob === null ? 'missing' : previousDrainJob.failed, null);
  check('the operator hold is still open after its tick', open(await call('/holds')), ['operator:op-1']);
  check('its release statement is refused', typeof (await call('/producer-release?token=op-1')).raised, 'string');
  const previousAdmission = await call('/admission');
  check('its admission fails and opens no hold', [typeof previousAdmission.raised, open(await call('/holds'))], ['string', ['operator:op-1']]);
  await call('/register?key=' + 'b'.repeat(64));
  check('its deletions defer too', (await call('/release?key=' + 'b'.repeat(64))).value, { released: 0, deferred: 1 });
  const previousState = await call('/state');
  check('nothing is journaled and both objects are kept', [previousState.journal, previousState.objects, previousState.blobs.length], [0, 2, 2]);
  note('the previous release wake', previousWake);
  await halt();

  // This release, with both holders open.
  await start('current');
  const admitted = await call('/admission');
  check('an admission opens its own producer hold beside the operator hold', [typeof admitted.value?.token, open(await call('/holds')).length], ['string', 2]);
  const wake = await call('/wake');
  const currentHoldJob = job(wake, 'recovery-hold-release');
  check('the hold-release job succeeds', currentHoldJob === null ? 'missing' : currentHoldJob.failed, null);
  const holds = await call('/holds');
  check('it settles the producer hold and leaves the operator hold open', [open(holds), holds.find((h: any) => h.holder === 'producer')?.released_by], [['operator:op-1'], 'producer']);
  check('the open operator hold is what an owner is told about', (await call('/operator-open')).value?.token, 'op-1');
  check('releasing it answers once', (await call('/operator-release?token=op-1&now=30&reason=complete')).value, true);
  for (let pass = 0; pass < 5; pass += 1) await call('/wake');
  const drained = await call('/state');
  check('the drain then decides and deletes everything the hold deferred', [drained.blobs.length, drained.journal, drained.candidates, drained.objects], [0, 0, 0, 0]);
  await halt();

  // The previous release again, after the operator released.
  await start('previous');
  check('its release statement changes nothing on the released hold', (await call('/producer-release?token=op-1')).value, false);
  check('the released operator hold is unchanged', (await call('/holds')).find((h: any) => h.token === 'op-1').release_reason, 'complete');
  await halt();
} catch (error) {
  failure = error;
  console.log(`FAILED: ${String(error).slice(0, 400)}`);
} finally {
  await halt();
}
const leftovers = owned.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
for (const { pid } of leftovers) { try { process.kill(pid, 'SIGKILL'); } catch {} }
const passed = checks.filter((entry) => entry.ok === true).length;
fs.writeFileSync(EVIDENCE, JSON.stringify({
  at: new Date().toISOString(), previousCommit: PREVIOUS_COMMIT, run: RUN, passed,
  total: checks.filter((entry) => 'check' in entry).length, failure: failure === null ? null : String(failure).slice(0, 400),
  owned, leftovers: leftovers.length, checks,
}, null, 2));
console.log(`${failure === null && leftovers.length === 0 ? 'passed' : 'FAILED'}: ${passed} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
process.exitCode = failure === null && leftovers.length === 0 ? 0 : 1;
